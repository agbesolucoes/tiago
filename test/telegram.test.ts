import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events, ideas, integrationAccounts, pendingConfirmations, tasks, telegramLinkCodes } from "../src/db/schema";
import { refreshCalendarList } from "../src/integrations/calendar-sync";
import { googleFetch } from "../src/integrations/google-client";
import { createLinkCode, handleUpdate, sendDailySummaries } from "../src/integrations/telegram-bot";
import { telegramFetch, type TgUpdate } from "../src/integrations/telegram-client";
import { newId } from "../src/lib/crypto";
import { parseDateTime } from "../src/lib/time";
import { encryptSecret } from "../src/lib/secret";
import { FakeGoogle } from "./fake-google";
import { call, db, json, makeUser, type TestUser } from "./helpers";

/** Bot API em memória: guarda o que o bot mandou. */
class FakeTelegram {
  calls: { method: string; body: any }[] = [];
  nextId = 100;
  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    this.calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: ++this.nextId } : true }));
  }) as typeof fetch;
  sent() {
    return this.calls.filter((c) => c.method === "sendMessage");
  }
  last() {
    return this.sent().at(-1)?.body;
  }
  lastEdit() {
    return this.calls.filter((c) => c.method === "editMessageText").at(-1)?.body;
  }
}

let tg: FakeTelegram;
let g: FakeGoogle;
const realTg = telegramFetch.impl;
const realGoogle = googleFetch.impl;
beforeEach(() => {
  tg = new FakeTelegram();
  g = new FakeGoogle();
  telegramFetch.impl = tg.fetch;
  googleFetch.impl = g.fetch;
});
afterEach(() => {
  telegramFetch.impl = realTg;
  googleFetch.impl = realGoogle;
});

// Quarta, 30/09/2026, 10:00 em São Paulo.
const NOW = Date.UTC(2026, 8, 30, 13, 0);
const deps = { db: db(), env, now: () => NOW };
let updateId = 1000;
let tgUser = 5000;

const msg = (from: number, text: string, chatType: "private" | "group" = "private"): TgUpdate => ({
  update_id: ++updateId,
  message: { message_id: updateId, from: { id: from, username: `u${from}` }, chat: { id: chatType === "private" ? from : -1, type: chatType }, text },
});
const tap = (from: number, data: string): TgUpdate => ({
  update_id: ++updateId,
  callback_query: { id: `cb${updateId}`, from: { id: from }, data, message: { message_id: 1, chat: { id: from, type: "private" } } },
});
const send = (u: TgUpdate) => handleUpdate(deps, u);
const buttons = () => tg.last()?.reply_markup?.inline_keyboard?.flat() as { text: string; callback_data: string }[];

async function linked(opts: Parameters<typeof makeUser>[0] = {}) {
  const user = await makeUser(opts);
  const from = ++tgUser;
  const { code } = await createLinkCode(db(), user.workspaceId, user.id, NOW);
  await send(msg(from, `/start ${code}`));
  return { user, from };
}

async function connectGoogle(user: TestUser) {
  const id = newId();
  await db().insert(integrationAccounts).values({ id, workspaceId: user.workspaceId, userId: user.id, provider: "google", externalSub: "g", email: "g@x.com", scopes: "calendar", refreshTokenEnc: await encryptSecret("r", env.TOKEN_ENCRYPTION_KEY) });
  const account = (await db().query.integrationAccounts.findFirst({ where: eq(integrationAccounts.id, id) }))!;
  await refreshCalendarList({ db: db(), env }, account);
}

describe("webhook", () => {
  const post = (body: unknown, secret?: string) =>
    call(null, "POST", "/integrations/telegram/webhook", body, secret === undefined ? {} : { "x-telegram-bot-api-secret-token": secret });

  it("recusa requisição sem o segredo do Telegram", async () => {
    expect((await post(msg(1, "/ajuda"))).status).toBe(401);
    expect((await post(msg(1, "/ajuda"), "errado")).status).toBe(401);
    expect(tg.calls).toHaveLength(0);
  });

  it("processa uma retransmissão do mesmo update uma vez só", async () => {
    const u = msg(++tgUser, "/ajuda");
    expect((await post(u, "segredo-webhook")).status).toBe(200);
    expect((await post(u, "segredo-webhook")).status).toBe(200);
    expect(tg.sent()).toHaveLength(1);
  });
});

describe("vínculo", () => {
  it("gera código na Central e liga pelo user_id do Telegram", async () => {
    const user = await makeUser();
    const res = await call(user, "POST", "/api/integrations/telegram/code", {});
    expect(res.status).toBe(201);
    const { code, deepLink } = await json(res);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(deepLink).toBe(`https://t.me/CentralTesteBot?start=${code}`);
    // Só o hash fica no banco.
    const rows = await db().select().from(telegramLinkCodes).where(eq(telegramLinkCodes.userId, user.id));
    expect(rows[0].codeHash).not.toContain(code);

    await send(msg(777001, `/start ${code}`));
    expect(tg.last().text).toContain("ligado à Central");
    const status = await json(await call(user, "GET", "/api/integrations/telegram"));
    expect(status).toMatchObject({ enabled: true, linked: true, username: "u777001" });

    // O código é de uso único.
    await send(msg(777002, `/vincular ${code}`));
    expect(tg.last().text).toContain("Código inválido");
  });

  it("recusa código vencido e quem não está ligado", async () => {
    const user = await makeUser();
    const { code } = await createLinkCode(db(), user.workspaceId, user.id, NOW - 20 * 60_000);
    await send(msg(777003, `/start ${code}`));
    expect(tg.last().text).toContain("Código inválido");
    await send(msg(777003, "/tarefa algo"));
    expect(tg.last().text).toContain("não está ligada");
    expect(await db().select().from(tasks).where(eq(tasks.workspaceId, user.workspaceId))).toHaveLength(0);
  });

  it("ignora grupos", async () => {
    const { user, from } = await linked();
    tg.calls = [];
    expect(await send(msg(from, "/tarefa em grupo", "group"))).toBe("ignored");
    expect(tg.calls).toHaveLength(0);
    expect(await db().select().from(tasks).where(eq(tasks.workspaceId, user.workspaceId))).toHaveLength(0);
  });

  it("desvincular pela Central corta o acesso do bot", async () => {
    const { user, from } = await linked();
    expect((await call(user, "DELETE", "/api/integrations/telegram")).status).toBe(204);
    await send(msg(from, "/hoje"));
    expect(tg.last().text).toContain("não está ligada");
  });
});

describe("comandos", () => {
  it("cria tarefa com prazo relativo no fuso de São Paulo", async () => {
    const { user, from } = await linked();
    await send(msg(from, "/tarefa ligar para o contador amanhã 14h"));
    const [t] = await db().select().from(tasks).where(eq(tasks.workspaceId, user.workspaceId));
    expect(t).toMatchObject({ title: "ligar para o contador", assigneeId: user.id, dueAt: parseDateTime("2026-10-01T14:00", "America/Sao_Paulo") });
    expect(tg.last().text).toBe("Tarefa criada: ligar para o contador, prazo Quinta-feira, 01/10/2026 às 14:00.");
  });

  it("guarda ideia com origem Telegram", async () => {
    const { user, from } = await linked();
    await send(msg(from, "/ideia newsletter mensal"));
    const [i] = await db().select().from(ideas).where(eq(ideas.workspaceId, user.workspaceId));
    expect(i).toMatchObject({ title: "newsletter mensal", origin: "Telegram" });
  });

  it("mostra o dia com compromissos, tarefas e atrasadas", async () => {
    const { user, from } = await linked();
    const tz = "America/Sao_Paulo";
    await db().insert(events).values({ id: newId(), workspaceId: user.workspaceId, title: "Dentista", startAt: parseDateTime("2026-09-30T15:00", tz)!, endAt: parseDateTime("2026-09-30T16:00", tz)!, timezone: tz });
    await db().insert(tasks).values([
      { id: newId(), workspaceId: user.workspaceId, title: "Pagar boleto", dueAt: parseDateTime("2026-09-30T00:00", tz) },
      { id: newId(), workspaceId: user.workspaceId, title: "Enviar relatório", dueAt: parseDateTime("2026-09-28T00:00", tz) },
    ]);
    await send(msg(from, "/hoje"));
    const text = tg.last().text;
    expect(text).toContain("• 15:00–16:00 Dentista");
    expect(text).toContain("Tarefas para hoje:\n• Pagar boleto");
    expect(text).toContain("Atrasadas:\n• Enviar relatório (28/09)");
  });
});

describe("compromissos pelo Telegram", () => {
  it("pede o que falta e não grava nada", async () => {
    const { user, from } = await linked();
    await send(msg(from, "/evento reunião com fornecedor"));
    expect(tg.last().text).toContain("Faltou o dia e o horário");
    expect(await db().select().from(pendingConfirmations).where(eq(pendingConfirmations.userId, user.id))).toHaveLength(0);
  });

  it("só grava depois do Confirmar e não duplica com toque repetido", async () => {
    const { user, from } = await linked();
    await send(msg(from, "/evento reunião com fornecedor sexta das 9h às 10h30"));
    expect(tg.last().text).toContain("Sexta-feira, 02/10/2026, das 09:00 às 10:30");
    expect(await db().select().from(events).where(eq(events.workspaceId, user.workspaceId))).toHaveLength(0);
    const confirm = buttons().find((b) => b.text === "Confirmar")!;

    await send(tap(from, confirm.callback_data));
    await send(tap(from, confirm.callback_data));
    const rows = await db().select().from(events).where(eq(events.workspaceId, user.workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "reunião com fornecedor", startAt: parseDateTime("2026-10-02T09:00", "America/Sao_Paulo") });
    expect(tg.lastEdit().text).toContain("Salvo na Central (o Google Agenda não está conectado)");
    expect(tg.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)!.body.text).toBe("Isso já foi resolvido.");
  });

  it("avisa conflito e cancelar não grava", async () => {
    const { user, from } = await linked();
    const tz = "America/Sao_Paulo";
    await db().insert(events).values({ id: newId(), workspaceId: user.workspaceId, title: "Almoço", startAt: parseDateTime("2026-10-01T12:00", tz)!, endAt: parseDateTime("2026-10-01T13:00", tz)!, timezone: tz });
    await send(msg(from, "/evento call amanhã 12h30"));
    expect(tg.last().text).toContain("conflita com:\n• 12:00–13:00 Almoço");
    await send(tap(from, buttons().find((b) => b.text === "Cancelar")!.callback_data));
    expect(tg.lastEdit().text).toBe("Ok, nada foi alterado.");
    expect(await db().select().from(events).where(eq(events.workspaceId, user.workspaceId))).toHaveLength(1);
  });

  it("confirma no Google antes de dizer que agendou", async () => {
    const { user, from } = await linked();
    await connectGoogle(user);
    await send(msg(from, "/evento dentista amanhã 14h"));
    await send(tap(from, buttons()[0].callback_data));
    const [ev] = await db().select().from(events).where(eq(events.workspaceId, user.workspaceId));
    expect(ev.syncStatus).toBe("synced");
    expect(g.store("primary@x.com").size).toBe(1);
    expect(tg.lastEdit().text).toContain("Agendado na Central e no Google Agenda");
  });

  it("falha transitória do Google não vira “agendado”", async () => {
    const { user, from } = await linked();
    await connectGoogle(user);
    g.failNext.set("POST primary@x.com", 503);
    await send(msg(from, "/evento dentista amanhã 14h"));
    await send(tap(from, buttons()[0].callback_data));
    const [ev] = await db().select().from(events).where(eq(events.workspaceId, user.workspaceId));
    expect(ev.syncStatus).toBe("pending");
    expect(tg.lastEdit().text).toContain("O Google Agenda ainda não confirmou");
  });

  it("cancelar compromisso exige dono ou administrador e confirmação", async () => {
    const { user: owner, from: ownerTg } = await linked();
    const { from: memberTg } = await linked({ workspaceId: owner.workspaceId, role: "member" });
    const tz = "America/Sao_Paulo";
    const id = newId();
    await db().insert(events).values({ id, workspaceId: owner.workspaceId, title: "Visita técnica", startAt: parseDateTime("2026-10-05T10:00", tz)!, endAt: parseDateTime("2026-10-05T11:00", tz)!, timezone: tz });

    await send(msg(memberTg, "/cancelar visita"));
    expect(tg.last().text).toContain("Só o dono ou um administrador");

    await send(msg(ownerTg, "/cancelar visita"));
    expect(await db().select().from(events).where(eq(events.id, id))).toHaveLength(1);
    await send(tap(ownerTg, buttons().find((b) => b.text === "Cancelar compromisso")!.callback_data));
    expect(await db().select().from(events).where(eq(events.id, id))).toHaveLength(0);
    expect(tg.lastEdit().text).toContain("Cancelado na Central");
  });

  it("confirmação de outra pessoa não vale", async () => {
    const { from } = await linked();
    const { user: other, from: otherTg } = await linked();
    await send(msg(from, "/evento dentista amanhã 14h"));
    await send(tap(otherTg, buttons()[0].callback_data));
    expect(await db().select().from(events).where(eq(events.workspaceId, other.workspaceId))).toHaveLength(0);
  });
});

describe("concluir tarefa", () => {
  it("conclui direto quando só uma tarefa casa", async () => {
    const { user, from } = await linked();
    const id = newId();
    await db().insert(tasks).values({ id, workspaceId: user.workspaceId, title: "Ligar para o contador" });
    await send(msg(from, "/concluir contador"));
    expect((await db().query.tasks.findFirst({ where: eq(tasks.id, id) }))!.status).toBe("done");
  });

  it("mostra as opções quando é ambíguo e conclui só a escolhida", async () => {
    const { user, from } = await linked();
    const [a, b] = [newId(), newId()];
    await db().insert(tasks).values([
      { id: a, workspaceId: user.workspaceId, title: "Revisar proposta A" },
      { id: b, workspaceId: user.workspaceId, title: "Revisar proposta B" },
    ]);
    await send(msg(from, "/concluir proposta"));
    expect(tg.last().text).toBe("Qual delas você concluiu?");
    const pick = buttons().find((x) => x.text === "Revisar proposta B")!;
    await send(tap(from, pick.callback_data));
    const rows = await db().select().from(tasks).where(and(eq(tasks.workspaceId, user.workspaceId), eq(tasks.status, "done")));
    expect(rows.map((r) => r.id)).toEqual([b]);
  });
});

describe("resumo diário", () => {
  it("manda só para quem tem algo no dia e deixou o resumo ativo", async () => {
    const tz = "America/Sao_Paulo";
    const withItems = await linked();
    await db().insert(tasks).values({ id: newId(), workspaceId: withItems.user.workspaceId, title: "Pagar boleto", dueAt: parseDateTime("2026-09-30T00:00", tz) });
    const empty = await linked();
    const off = await linked();
    await db().insert(tasks).values({ id: newId(), workspaceId: off.user.workspaceId, title: "Outra", dueAt: parseDateTime("2026-09-30T00:00", tz) });
    expect((await call(off.user, "PATCH", "/api/integrations/telegram", { dailySummary: false })).status).toBe(200);

    tg.calls = [];
    await sendDailySummaries(deps);
    const chats = tg.sent().map((c) => c.body.chat_id);
    expect(chats).toContain(String(withItems.from));
    expect(chats).not.toContain(String(empty.from));
    expect(chats).not.toContain(String(off.from));
    expect(tg.sent().find((c) => c.body.chat_id === String(withItems.from))!.body.text).toContain("Bom dia!");
  });
});
