import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calendars, events, integrationAccounts, telegramLinks } from "../src/db/schema";
import { googleIdFor, processJobs, refreshCalendarList, syncCalendar } from "../src/integrations/calendar-sync";
import { googleFetch } from "../src/integrations/google-client";
import { sendReminders } from "../src/integrations/reminders";
import { telegramFetch } from "../src/integrations/telegram-client";
import { newId } from "../src/lib/crypto";
import { encryptSecret } from "../src/lib/secret";
import { parseDateTime } from "../src/lib/time";
import { FakeGoogle } from "./fake-google";
import { call, db, json, makeUser, type TestUser } from "./helpers";

const TZ = "America/Sao_Paulo";
const at = (s: string) => parseDateTime(s, TZ)!;
const iso = (s: string) => new Date(at(s)).toISOString();

let g: FakeGoogle;
const realGoogle = googleFetch.impl;
beforeEach(() => {
  g = new FakeGoogle();
  googleFetch.impl = g.fetch;
});
afterEach(() => {
  googleFetch.impl = realGoogle;
});

async function week(u: TestUser, from = "2026-10-05", to = "2026-10-19") {
  const rows = await json<any[]>(await call(u, "GET", `/api/events?from=${from}&to=${to}`));
  return rows.map((r) => `${r.title}@${r.startAt}`);
}

async function createWeekly(u: TestUser, extra: Record<string, unknown> = {}) {
  const res = await call(u, "POST", "/api/events", {
    title: "Reunião de equipe",
    startAt: "2026-10-05T09:00",
    endAt: "2026-10-05T10:00",
    repeat: { freq: "weekly", interval: 1, byDay: ["MO", "WE"] },
    ...extra,
  });
  expect(res.status).toBe(201);
  return json(res);
}

describe("séries na API", () => {
  it("cria série semanal e lista as ocorrências do intervalo", async () => {
    const u = await makeUser();
    const ev = await createWeekly(u);
    expect(ev).toMatchObject({ recurrence: "FREQ=WEEKLY;BYDAY=MO,WE", repeat: { freq: "weekly", interval: 1, byDay: ["MO", "WE"] }, recurrenceEndsAt: null });
    expect(await week(u)).toEqual([
      `Reunião de equipe@${iso("2026-10-05T09:00")}`,
      `Reunião de equipe@${iso("2026-10-07T09:00")}`,
      `Reunião de equipe@${iso("2026-10-12T09:00")}`,
      `Reunião de equipe@${iso("2026-10-14T09:00")}`,
    ]);
    const [first] = await json<any[]>(await call(u, "GET", "/api/events?from=2026-10-07&to=2026-10-08"));
    expect(first).toMatchObject({ id: ev.id, seriesId: ev.id, recurring: true, occurrenceStart: iso("2026-10-07T09:00") });
  });

  it("série com fim: número de vezes e data final", async () => {
    const u = await makeUser();
    const r = await createWeekly(u, { repeat: { freq: "daily", interval: 2, count: 3 } });
    expect(r.recurrenceEndsAt).toBe(iso("2026-10-09T10:00"));
    expect(await week(u)).toHaveLength(3);
    const bad = await call(u, "POST", "/api/events", { title: "x", startAt: "2026-10-05T09:00", endAt: "2026-10-05T10:00", repeat: { freq: "daily", until: "2026-10-01", interval: 1 } });
    expect(bad.status).toBe(400);
    const both = await call(u, "POST", "/api/events", { title: "x", startAt: "2026-10-05T09:00", endAt: "2026-10-05T10:00", repeat: { freq: "daily", interval: 1, until: "2026-11-01", count: 2 } });
    expect(both.status).toBe(400);
  });

  it("tira uma ocorrência sem apagar a série", async () => {
    const u = await makeUser();
    const ev = await createWeekly(u);
    const res = await call(u, "POST", `/api/events/${ev.id}/occurrences/skip`, { occurrenceStart: iso("2026-10-07T09:00") });
    expect(res.status).toBe(200);
    expect(await week(u)).not.toContain(`Reunião de equipe@${iso("2026-10-07T09:00")}`);
    expect(await week(u)).toHaveLength(3);
    // Data que não é da série.
    expect((await call(u, "POST", `/api/events/${ev.id}/occurrences/skip`, { occurrenceStart: iso("2026-10-08T09:00") })).status).toBe(400);
  });

  it("altera só uma ocorrência e exclui a alteração sem trazer a original de volta", async () => {
    const u = await makeUser();
    const ev = await createWeekly(u);
    const res = await call(u, "POST", `/api/events/${ev.id}/occurrences/detach`, {
      occurrenceStart: iso("2026-10-12T09:00"),
      title: "Reunião de equipe (remarcada)",
      startAt: "2026-10-13T15:00",
      endAt: "2026-10-13T16:00",
    });
    expect(res.status).toBe(201);
    const one = await json(res);
    expect(one).toMatchObject({ seriesId: ev.id, originalStartAt: iso("2026-10-12T09:00"), recurring: true, repeat: null });
    expect(await week(u)).toEqual([
      `Reunião de equipe@${iso("2026-10-05T09:00")}`,
      `Reunião de equipe@${iso("2026-10-07T09:00")}`,
      `Reunião de equipe (remarcada)@${iso("2026-10-13T15:00")}`,
      `Reunião de equipe@${iso("2026-10-14T09:00")}`,
    ]);
    expect((await call(u, "PATCH", `/api/events/${one.id}`, { repeat: { freq: "daily", interval: 1 } })).status).toBe(400);
    expect((await call(u, "DELETE", `/api/events/${one.id}`)).status).toBe(204);
    expect(await week(u)).toHaveLength(3);
  });

  it("excluir a série apaga as ocorrências avulsas", async () => {
    const u = await makeUser();
    const ev = await createWeekly(u);
    await call(u, "POST", `/api/events/${ev.id}/occurrences/detach`, { occurrenceStart: iso("2026-10-12T09:00"), title: "Avulsa" });
    expect((await call(u, "DELETE", `/api/events/${ev.id}`)).status).toBe(204);
    expect(await week(u)).toEqual([]);
    expect(await db().select().from(events).where(eq(events.workspaceId, u.workspaceId))).toHaveLength(0);
  });

  it("mudar o horário da série limpa as exclusões; tirar a repetição vira compromisso único", async () => {
    const u = await makeUser();
    const ev = await createWeekly(u);
    await call(u, "POST", `/api/events/${ev.id}/occurrences/skip`, { occurrenceStart: iso("2026-10-07T09:00") });
    const moved = await json(await call(u, "PATCH", `/api/events/${ev.id}`, { startAt: "2026-10-05T11:00", endAt: "2026-10-05T12:00" }));
    expect(moved.exdates).toEqual([]);
    expect(await week(u)).toHaveLength(4);
    const single = await json(await call(u, "PATCH", `/api/events/${ev.id}`, { repeat: null }));
    expect(single).toMatchObject({ recurrence: null, recurring: false });
    expect(await week(u)).toHaveLength(1);
  });

  it("aponta conflito com uma ocorrência e mostra a série no painel do dia", async () => {
    const u = await makeUser();
    await createWeekly(u);
    const res = await json(await call(u, "POST", "/api/events", { title: "Dentista", startAt: "2026-10-14T09:30", endAt: "2026-10-14T10:30" }));
    expect(res.conflicts.map((c: any) => c.title)).toEqual(["Reunião de equipe"]);
  });
});

describe("séries no Google", () => {
  async function connect(u: TestUser) {
    const id = newId();
    await db().insert(integrationAccounts).values({ id, workspaceId: u.workspaceId, userId: u.id, provider: "google", externalSub: "g", email: "g@x.com", scopes: "calendar", refreshTokenEnc: await encryptSecret("r", env.TOKEN_ENCRYPTION_KEY) });
    const account = (await db().query.integrationAccounts.findFirst({ where: eq(integrationAccounts.id, id) }))!;
    await refreshCalendarList({ db: db(), env }, account);
    const cal = (await db().query.calendars.findFirst({ where: and(eq(calendars.accountId, id), eq(calendars.primary, true)) }))!;
    return { account, cal };
  }

  it("envia a regra, as exclusões e o lembrete", async () => {
    const u = await makeUser();
    await connect(u);
    const ev = await createWeekly(u, { reminderMinutes: 30 });
    await call(u, "POST", `/api/events/${ev.id}/occurrences/skip`, { occurrenceStart: iso("2026-10-07T09:00") });
    await processJobs({ db: db(), env }, { workspaceId: u.workspaceId });
    const remote = g.store("primary@x.com").get(googleIdFor(ev.id))!;
    expect(remote.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE;TZID=America/Sao_Paulo:20261007T090000"]);
    expect(remote.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 30 }] });
  });

  it("traz série, ocorrência apagada e ocorrência alterada, em qualquer ordem", async () => {
    const u = await makeUser();
    const { account, cal } = await connect(u);
    g.pageSize = 1;
    // A exceção chega antes da série.
    g.put("primary@x.com", {
      id: "serie1_20261012T120000Z",
      recurringEventId: "serie1",
      originalStartTime: { dateTime: "2026-10-12T09:00:00-03:00" },
      summary: "Aula (sala 2)",
      start: { dateTime: "2026-10-12T10:00:00-03:00", timeZone: TZ },
      end: { dateTime: "2026-10-12T11:00:00-03:00", timeZone: TZ },
    });
    g.put("primary@x.com", { id: "serie1_20261007T120000Z", recurringEventId: "serie1", originalStartTime: { dateTime: "2026-10-07T09:00:00-03:00" }, status: "cancelled" });
    g.put("primary@x.com", {
      id: "serie1",
      summary: "Aula",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"],
      start: { dateTime: "2026-10-05T09:00:00-03:00", timeZone: TZ },
      end: { dateTime: "2026-10-05T10:00:00-03:00", timeZone: TZ },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
    });
    await syncCalendar({ db: db(), env }, account, cal);
    expect(await week(u)).toEqual([
      `Aula@${iso("2026-10-05T09:00")}`,
      `Aula (sala 2)@${iso("2026-10-12T10:00")}`,
      `Aula@${iso("2026-10-14T09:00")}`,
    ]);
    const master = (await db().query.events.findFirst({ where: and(eq(events.workspaceId, u.workspaceId), eq(events.remoteId, "serie1")) }))!;
    expect(master.reminderMinutes).toBe(15);
    expect(master.exdates).toEqual([at("2026-10-07T09:00")]);
  });
});

describe("lembretes pelo Telegram", () => {
  it("avisa uma vez por ocorrência, na antecedência escolhida", async () => {
    const sent: any[] = [];
    const realTg = telegramFetch.impl;
    telegramFetch.impl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch;
    try {
      const u = await makeUser();
      await db().insert(telegramLinks).values({ id: newId(), workspaceId: u.workspaceId, userId: u.id, telegramUserId: String(Math.random()), chatId: "42" });
      await createWeekly(u, { title: "Academia", reminderMinutes: 30 });
      const deps = (s: string) => ({ db: db(), env, now: () => at(s) });

      await sendReminders(deps("2026-10-07T08:20"));
      expect(sent.filter((m) => m.text.includes("Academia"))).toHaveLength(0);
      await sendReminders(deps("2026-10-07T08:31"));
      await sendReminders(deps("2026-10-07T08:36"));
      const mine = sent.filter((m) => m.text.includes("Academia"));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ chat_id: "42", text: "Lembrete: Academia às 09:00 (em 30 minutos)" });
      // Ocorrência seguinte tem o próprio lembrete.
      await sendReminders(deps("2026-10-12T08:35"));
      expect(sent.filter((m) => m.text.includes("Academia"))).toHaveLength(2);
    } finally {
      telegramFetch.impl = realTg;
    }
  });
});
