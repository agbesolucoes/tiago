// Bot do Telegram: vínculo por código, comandos em conversa privada e confirmação antes de gravar
// compromissos, exclusões e conclusões ambíguas.

import { and, asc, desc, eq, gt, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { RequestContext } from "../api/context";
import { auditInsert, likePattern } from "../api/helpers";
import type { Db } from "../db/client";
import {
  events,
  ideas,
  memberships,
  pendingConfirmations,
  processedUpdates,
  syncJobs,
  tasks,
  telegramLinkCodes,
  telegramLinks,
  workspaces,
} from "../db/schema";
import type { Env } from "../env";
import { newId, sha256 } from "../lib/crypto";
import { recordError } from "../lib/log";
import { addMinutes, parseWhen } from "../lib/nl-date";
import { localDayRange, parseDateTime } from "../lib/time";
import { enqueueStatements, processJobs } from "./calendar-sync";
import { TelegramClient, type InlineButton, type TgMessage, type TgUpdate } from "./telegram-client";

export interface BotDeps {
  db: Db;
  env: Env;
  now?: () => number;
}

export const LINK_CODE_TTL = 15 * 60_000;
const CONFIRMATION_TTL = 30 * 60_000;
const MAX_OPTIONS = 6;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type Link = typeof telegramLinks.$inferSelect;
type Confirmation = typeof pendingConfirmations.$inferSelect;

export function telegramEnabled(env: Env) {
  return !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_WEBHOOK_SECRET;
}

/** Código curto (8 caracteres, sem letras ambíguas) para vincular a conta. Guardamos só o hash. */
export async function createLinkCode(db: Db, workspaceId: string, userId: string, now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const expiresAt = now + LINK_CODE_TTL;
  await db.batch([
    // Um código válido por pessoa: gerar outro invalida o anterior.
    db.delete(telegramLinkCodes).where(or(eq(telegramLinkCodes.userId, userId), lt(telegramLinkCodes.expiresAt, now))),
    db.insert(telegramLinkCodes).values({ codeHash: await sha256(code), workspaceId, userId, expiresAt }),
  ]);
  return { code, expiresAt };
}

// ---------- Formatação ----------

function fmt(ms: number, tz: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, ...opts }).format(new Date(ms));
}
const hour = (ms: number, tz: string) => fmt(ms, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function day(ms: number, tz: string) {
  const s = fmt(ms, tz, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function when(start: number, end: number, tz: string) {
  const sameDay = fmt(start, tz, { dateStyle: "short" }) === fmt(end, tz, { dateStyle: "short" });
  return sameDay ? `${day(start, tz)}, das ${hour(start, tz)} às ${hour(end, tz)}` : `${day(start, tz)} ${hour(start, tz)} até ${day(end, tz)} ${hour(end, tz)}`;
}

const HELP = [
  "Comandos da Central:",
  "/hoje: compromissos e tarefas de hoje",
  "/tarefa ligar para o contador amanhã",
  "/ideia newsletter mensal para clientes",
  "/evento reunião com fornecedor sexta das 9h às 10h",
  "/concluir contador",
  "/cancelar reunião com fornecedor",
  "",
  "Datas aceitas: hoje, amanhã, sexta, 12/10, dia 15; horas como 14h, 14:30 ou 9h às 10h.",
].join("\n");

// ---------- Entrada ----------

/**
 * Trata um update do webhook. Retransmissões do mesmo update_id são ignoradas pelo índice único.
 * Se o processamento falhar antes de gravar, o registro do update é desfeito para o Telegram tentar de novo.
 */
export async function handleUpdate(deps: BotDeps, update: TgUpdate): Promise<"ok" | "duplicate" | "ignored"> {
  const inserted = await deps.db
    .insert(processedUpdates)
    .values({ updateId: update.update_id })
    .onConflictDoNothing()
    .returning({ id: processedUpdates.updateId });
  if (!inserted.length) return "duplicate";
  try {
    if (update.callback_query) return await onCallback(deps, update.callback_query);
    if (update.message) return await onMessage(deps, update.message);
    return "ignored";
  } catch (e) {
    await deps.db.delete(processedUpdates).where(eq(processedUpdates.updateId, update.update_id));
    throw e;
  }
}

function client(env: Env) {
  return new TelegramClient(env.TELEGRAM_BOT_TOKEN!);
}

/** Resposta ao usuário. Falhar ao enviar não desfaz o que já foi gravado. */
async function say(deps: BotDeps, chatId: number | string, text: string, buttons?: InlineButton[][]) {
  try {
    await client(deps.env).sendMessage(chatId, text, buttons);
  } catch (e) {
    await recordError(deps.db, "telegram envio", e);
  }
}

async function contextFor(db: Db, link: Link): Promise<RequestContext | null> {
  const row = await db
    .select({ role: memberships.role, timezone: workspaces.timezone })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.workspaceId, link.workspaceId), eq(memberships.userId, link.userId)))
    .get();
  return row ? { db, userId: link.userId, workspaceId: link.workspaceId, ...row } : null;
}

async function linkFor(db: Db, telegramUserId: number) {
  const link = await db.query.telegramLinks.findFirst({ where: eq(telegramLinks.telegramUserId, String(telegramUserId)) });
  if (!link) return null;
  const ctx = await contextFor(db, link);
  return ctx ? { link, ctx } : null;
}

type Outcome = "ok" | "duplicate" | "ignored";

async function onMessage(deps: BotDeps, msg: TgMessage): Promise<Outcome> {
  // Só conversa privada: em grupo, qualquer um leria as respostas.
  if (msg.chat.type !== "private" || !msg.from || !msg.text) return "ignored";
  const text = msg.text.trim();
  const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  const command = match?.[1].toLowerCase();
  const args = (match?.[2] ?? "").trim();

  if (command === "start" || command === "vincular") {
    if (args) return linkAccount(deps, msg, args);
  }
  const found = await linkFor(deps.db, msg.from.id);
  if (!found) {
    await say(deps, msg.chat.id, "Esta conta do Telegram ainda não está ligada à Central. Na Central, vá em Configurações, Telegram, gere um código e envie aqui: /vincular CÓDIGO");
    return "ok";
  }
  const { link, ctx } = found;
  const now = deps.now?.() ?? Date.now();
  switch (command) {
    case "start":
    case "ajuda":
    case "help":
      await say(deps, msg.chat.id, HELP);
      break;
    case "hoje":
      await say(deps, msg.chat.id, (await todaySummary(ctx, now))!);
      break;
    case "tarefa":
      await createTask(deps, ctx, link, args, now);
      break;
    case "ideia":
      await createIdea(deps, ctx, link, args);
      break;
    case "evento":
    case "compromisso":
      await proposeEvent(deps, ctx, link, args, now);
      break;
    case "concluir":
      await proposeComplete(deps, ctx, link, args, now);
      break;
    case "cancelar":
      await proposeCancel(deps, ctx, link, args, now);
      break;
    default:
      await say(deps, msg.chat.id, command ? `Não conheço o comando /${command}.\n\n${HELP}` : `Para registrar algo, comece com um comando.\n\n${HELP}`);
  }
  return "ok";
}

async function linkAccount(deps: BotDeps, msg: TgMessage, rawCode: string): Promise<Outcome> {
  const now = deps.now?.() ?? Date.now();
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const row = code.length === 8 ? await deps.db.query.telegramLinkCodes.findFirst({ where: eq(telegramLinkCodes.codeHash, await sha256(code)) }) : undefined;
  if (!row || row.expiresAt < now) {
    await say(deps, msg.chat.id, "Código inválido ou vencido. Gere outro em Configurações, Telegram, na Central.");
    return "ok";
  }
  const from = msg.from!;
  const values = { id: newId(), workspaceId: row.workspaceId, userId: row.userId, telegramUserId: String(from.id), chatId: String(msg.chat.id), username: from.username ?? null };
  const ctx = { db: deps.db, workspaceId: row.workspaceId, userId: row.userId } as RequestContext;
  await deps.db.batch([
    deps.db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.codeHash, row.codeHash)),
    // Uma conta do Telegram por pessoa, e cada conta do Telegram ligada a uma só pessoa.
    deps.db.delete(telegramLinks).where(or(eq(telegramLinks.telegramUserId, values.telegramUserId), and(eq(telegramLinks.workspaceId, row.workspaceId), eq(telegramLinks.userId, row.userId)))),
    deps.db.insert(telegramLinks).values(values),
    auditInsert(ctx, "telegram", values.id, "create", null, { telegramUserId: values.telegramUserId, username: values.username }),
  ]);
  await say(deps, msg.chat.id, `Pronto, este Telegram está ligado à Central.\n\n${HELP}`);
  return "ok";
}

// ---------- Consultas ----------

export async function todaySummary(ctx: RequestContext, now: number, opts: { skipEmpty?: boolean } = {}) {
  const tz = ctx.timezone;
  const [dayStart, dayEnd] = localDayRange(now, tz);
  const [evs, due] = await ctx.db.batch([
    ctx.db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, ctx.workspaceId), lt(events.startAt, dayEnd), gte(events.endAt, dayStart)))
      .orderBy(asc(events.startAt))
      .limit(20),
    ctx.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, ctx.workspaceId),
          ne(tasks.status, "done"),
          lt(tasks.dueAt, dayEnd),
          or(eq(tasks.assigneeId, ctx.userId), isNull(tasks.assigneeId)),
        ),
      )
      .orderBy(asc(tasks.dueAt))
      .limit(20),
  ]);
  if (opts.skipEmpty && !evs.length && !due.length) return null;
  const lines = [`${day(now, tz)}`];
  lines.push("", evs.length ? "Compromissos:" : "Nenhum compromisso hoje.");
  for (const e of evs) lines.push(`• ${hour(e.startAt, tz)}–${hour(e.endAt, tz)} ${e.title}`);
  const overdue = due.filter((t) => t.dueAt! < dayStart);
  const today = due.filter((t) => t.dueAt! >= dayStart);
  lines.push("", today.length ? "Tarefas para hoje:" : "Nenhuma tarefa para hoje.");
  for (const t of today) lines.push(`• ${t.title}`);
  if (overdue.length) {
    lines.push("", "Atrasadas:");
    for (const t of overdue) lines.push(`• ${t.title} (${fmt(t.dueAt!, tz, { day: "2-digit", month: "2-digit" })})`);
  }
  return lines.join("\n");
}

// ---------- Criação direta ----------

async function createTask(deps: BotDeps, ctx: RequestContext, link: Link, args: string, now: number) {
  const w = parseWhen(args, now, ctx.timezone);
  if (!w.title) {
    await say(deps, link.chatId, "Qual é a tarefa? Exemplo: /tarefa ligar para o contador amanhã");
    return;
  }
  const dueAt = w.date ? parseDateTime(`${w.date}T${w.start ?? "00:00"}`, ctx.timezone) : null;
  const row = { id: newId(), workspaceId: ctx.workspaceId, title: w.title.slice(0, 200), dueAt, assigneeId: ctx.userId, createdBy: ctx.userId };
  await ctx.db.batch([ctx.db.insert(tasks).values(row), auditInsert(ctx, "task", row.id, "create", null, { title: row.title, dueAt, via: "telegram" })]);
  const prazo = dueAt ? `, prazo ${w.start ? `${day(dueAt, ctx.timezone)} às ${hour(dueAt, ctx.timezone)}` : day(dueAt, ctx.timezone)}` : "";
  await say(deps, link.chatId, `Tarefa criada: ${row.title}${prazo}.`);
}

async function createIdea(deps: BotDeps, ctx: RequestContext, link: Link, args: string) {
  if (!args) {
    await say(deps, link.chatId, "Qual é a ideia? Exemplo: /ideia newsletter mensal para clientes");
    return;
  }
  const row = { id: newId(), workspaceId: ctx.workspaceId, title: args.slice(0, 200), origin: "Telegram", createdBy: ctx.userId };
  await ctx.db.batch([ctx.db.insert(ideas).values(row), auditInsert(ctx, "idea", row.id, "create", null, { title: row.title, origin: row.origin })]);
  await say(deps, link.chatId, `Ideia guardada: ${row.title}.`);
}

// ---------- Ações com confirmação ----------

async function propose(deps: BotDeps, ctx: RequestContext, link: Link, kind: Confirmation["kind"], payload: Record<string, unknown>, now: number) {
  const id = newId();
  await ctx.db.insert(pendingConfirmations).values({ id, workspaceId: ctx.workspaceId, userId: ctx.userId, kind, payload, expiresAt: now + CONFIRMATION_TTL });
  return id;
}

async function proposeEvent(deps: BotDeps, ctx: RequestContext, link: Link, args: string, now: number) {
  const w = parseWhen(args, now, ctx.timezone);
  const missing = [!w.title && "o que é", !w.date && "o dia", !w.start && "o horário"].filter(Boolean) as string[];
  if (missing.length) {
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(", ")} e ${missing.at(-1)}` : missing[0];
    await say(deps, link.chatId, `Faltou ${list}. Envie de novo com tudo junto, por exemplo:\n/evento dentista amanhã 14h\n/evento reunião sexta das 9h às 10h30`);
    return;
  }
  const end = w.end ?? addMinutes(w.start!, 60) ?? "23:59";
  const startAt = parseDateTime(`${w.date}T${w.start}`, ctx.timezone)!;
  const endAt = parseDateTime(`${w.date}T${end}`, ctx.timezone)!;
  if (endAt <= startAt) {
    await say(deps, link.chatId, "O término ficou antes do início. Confira os horários e envie de novo.");
    return;
  }
  const title = w.title.slice(0, 200);
  const clash = await ctx.db
    .select({ title: events.title, startAt: events.startAt, endAt: events.endAt })
    .from(events)
    .where(and(eq(events.workspaceId, ctx.workspaceId), lt(events.startAt, endAt), gt(events.endAt, startAt)))
    .orderBy(asc(events.startAt))
    .limit(3);
  const id = await propose(deps, ctx, link, "event.create", { title, startAt, endAt }, now);
  const lines = ["Confirma o compromisso?", "", title, when(startAt, endAt, ctx.timezone)];
  if (!w.end) lines.push("(duração de 1 hora; para outra, envie com o término, como 9h às 10h30)");
  if (clash.length) {
    lines.push("", "Atenção, conflita com:");
    for (const c of clash) lines.push(`• ${hour(c.startAt, ctx.timezone)}–${hour(c.endAt, ctx.timezone)} ${c.title}`);
  }
  await say(deps, link.chatId, lines.join("\n"), [[{ text: "Confirmar", callback_data: `c:${id}` }, { text: "Cancelar", callback_data: `x:${id}` }]]);
}

async function proposeComplete(deps: BotDeps, ctx: RequestContext, link: Link, args: string, now: number) {
  if (!args) {
    await say(deps, link.chatId, "Qual tarefa? Exemplo: /concluir contador");
    return;
  }
  const found = await ctx.db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.workspaceId, ctx.workspaceId), ne(tasks.status, "done"), sql`${tasks.title} LIKE ${likePattern(args)} ESCAPE '\\'`))
    .orderBy(asc(tasks.dueAt))
    .limit(MAX_OPTIONS + 1);
  if (!found.length) {
    await say(deps, link.chatId, `Não achei tarefa aberta com “${args}”.`);
    return;
  }
  if (found.length === 1) {
    await completeTask(ctx, found[0].id);
    await say(deps, link.chatId, `Concluída: ${found[0].title}.`);
    return;
  }
  // Mais de uma: mostra as opções e só conclui a escolhida.
  const options = found.slice(0, MAX_OPTIONS);
  const id = await propose(deps, ctx, link, "task.complete", { ids: options.map((t) => t.id), titles: options.map((t) => t.title) }, now);
  const more = found.length > MAX_OPTIONS ? "\n(há mais resultados; seja mais específico se não estiver aqui)" : "";
  await say(deps, link.chatId, `Qual delas você concluiu?${more}`, [
    ...options.map((t, i) => [{ text: t.title.slice(0, 60), callback_data: `c:${id}:${i}` }]),
    [{ text: "Nenhuma", callback_data: `x:${id}` }],
  ]);
}

async function proposeCancel(deps: BotDeps, ctx: RequestContext, link: Link, args: string, now: number) {
  if (ctx.role !== "owner" && ctx.role !== "admin") {
    await say(deps, link.chatId, "Só o dono ou um administrador pode cancelar compromissos.");
    return;
  }
  if (!args) {
    await say(deps, link.chatId, "Qual compromisso? Exemplo: /cancelar reunião com fornecedor");
    return;
  }
  const found = await ctx.db
    .select({ id: events.id, title: events.title, startAt: events.startAt, endAt: events.endAt })
    .from(events)
    .where(and(eq(events.workspaceId, ctx.workspaceId), gte(events.endAt, now), sql`${events.title} LIKE ${likePattern(args)} ESCAPE '\\'`))
    .orderBy(asc(events.startAt))
    .limit(MAX_OPTIONS);
  if (!found.length) {
    await say(deps, link.chatId, `Não achei compromisso futuro com “${args}”.`);
    return;
  }
  const id = await propose(deps, ctx, link, "event.delete", { ids: found.map((e) => e.id) }, now);
  const label = (e: (typeof found)[number]) => `${fmt(e.startAt, ctx.timezone, { day: "2-digit", month: "2-digit" })} ${hour(e.startAt, ctx.timezone)} ${e.title}`.slice(0, 60);
  if (found.length === 1) {
    const e = found[0];
    await say(deps, link.chatId, `Cancelar este compromisso? Ele sai da Central e do Google Agenda.\n\n${e.title}\n${when(e.startAt, e.endAt, ctx.timezone)}`, [
      [{ text: "Cancelar compromisso", callback_data: `c:${id}:0` }, { text: "Manter", callback_data: `x:${id}` }],
    ]);
    return;
  }
  await say(deps, link.chatId, "Qual compromisso você quer cancelar? Ele sai da Central e do Google Agenda.", [
    ...found.map((e, i) => [{ text: label(e), callback_data: `c:${id}:${i}` }]),
    [{ text: "Nenhum", callback_data: `x:${id}` }],
  ]);
}

async function completeTask(ctx: RequestContext, taskId: string) {
  const res = await ctx.db.batch([
    ctx.db
      .update(tasks)
      .set({ status: "done", updatedAt: Date.now() })
      .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, ctx.workspaceId), ne(tasks.status, "done"))),
    auditInsert(ctx, "task", taskId, "update", null, { status: "done", via: "telegram" }),
  ]);
  return res[0].meta.changes > 0;
}

// ---------- Botões ----------

async function onCallback(deps: BotDeps, cb: NonNullable<TgUpdate["callback_query"]>): Promise<Outcome> {
  const tg = client(deps.env);
  const answer = (text?: string) => tg.answerCallbackQuery(cb.id, text).catch((e) => console.error("telegram answer", e));
  const m = /^([cx]):([\w-]+)(?::(\d+))?$/.exec(cb.data ?? "");
  const found = m ? await linkFor(deps.db, cb.from.id) : null;
  if (!m || !found || !cb.message) {
    await answer("Ação inválida.");
    return "ignored";
  }
  const { ctx } = found;
  const now = deps.now?.() ?? Date.now();
  const [, action, id, index] = m;
  const conf = await ctx.db.query.pendingConfirmations.findFirst({
    where: and(eq(pendingConfirmations.id, id), eq(pendingConfirmations.userId, ctx.userId), eq(pendingConfirmations.workspaceId, ctx.workspaceId)),
  });
  const edit = (text: string) => tg.editMessageText(cb.message!.chat.id, cb.message!.message_id, text).catch((e) => console.error("telegram edit", e));
  if (!conf || conf.status !== "pending") {
    await answer("Isso já foi resolvido.");
    return "ok";
  }
  if (conf.expiresAt < now) {
    await ctx.db.update(pendingConfirmations).set({ status: "cancelled", updatedAt: now }).where(eq(pendingConfirmations.id, conf.id));
    await answer();
    await edit("Esta confirmação venceu e nada foi gravado. Envie o comando de novo.");
    return "ok";
  }
  // A troca pending → confirmed/cancelled é atômica: dois toques no botão não gravam duas vezes.
  const claimed = await ctx.db
    .update(pendingConfirmations)
    .set({ status: action === "c" ? "confirmed" : "cancelled", updatedAt: now })
    .where(and(eq(pendingConfirmations.id, conf.id), eq(pendingConfirmations.status, "pending")))
    .returning({ id: pendingConfirmations.id });
  if (!claimed.length) {
    await answer("Isso já foi resolvido.");
    return "ok";
  }
  if (action === "x") {
    await answer();
    await edit("Ok, nada foi alterado.");
    return "ok";
  }
  await answer();
  const text = await execute(deps, ctx, conf, index === undefined ? null : Number(index));
  await edit(text);
  return "ok";
}

async function execute(deps: BotDeps, ctx: RequestContext, conf: Confirmation, index: number | null): Promise<string> {
  const p = conf.payload as Record<string, any>;
  const tz = ctx.timezone;
  if (conf.kind === "task.complete") {
    const taskId = p.ids?.[index ?? -1];
    if (!taskId) return "Opção inválida; nada foi alterado.";
    return (await completeTask(ctx, taskId)) ? `Concluída: ${p.titles[index!]}.` : "Essa tarefa já estava concluída ou foi excluída.";
  }

  if (conf.kind === "event.create") {
    // O id do compromisso é o da confirmação: repetir a gravação nunca duplica, aqui nem no Google.
    const values = { title: p.title as string, startAt: p.startAt as number, endAt: p.endAt as number, timezone: tz };
    const row = { id: conf.id, workspaceId: ctx.workspaceId, createdBy: ctx.userId, ...values };
    const sync = await enqueueStatements(ctx.db, ctx.workspaceId, { id: row.id, calendarId: null, remoteId: null }, "event.upsert");
    await ctx.db.batch([ctx.db.insert(events).values(row).onConflictDoNothing(), auditInsert(ctx, "event", row.id, "create", null, { ...values, via: "telegram" }), ...sync]);
    const desc = `${values.title}\n${when(values.startAt, values.endAt, tz)}`;
    if (!sync.length) return `Salvo na Central (o Google Agenda não está conectado):\n\n${desc}`;
    return `${await pushNow(deps, ctx, row.id, "upsert")}\n\n${desc}`;
  }

  // event.delete
  const eventId = p.ids?.[index ?? -1];
  if (!eventId) return "Opção inválida; nada foi alterado.";
  if (ctx.role !== "owner" && ctx.role !== "admin") return "Só o dono ou um administrador pode cancelar compromissos.";
  const before = await ctx.db.query.events.findFirst({ where: and(eq(events.id, eventId), eq(events.workspaceId, ctx.workspaceId)) });
  if (!before) return "Esse compromisso já não existe na Central.";
  const sync = await enqueueStatements(ctx.db, ctx.workspaceId, before, "event.delete");
  await ctx.db.batch([
    ctx.db.delete(events).where(and(eq(events.id, before.id), eq(events.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "event", before.id, "delete", before, { via: "telegram" }),
    ...sync,
  ]);
  const desc = `${before.title}\n${when(before.startAt, before.endAt, tz)}`;
  // Sem remoteId, o compromisso nunca chegou ao Google: não há o que apagar lá.
  if (!sync.length || !before.remoteId) return `Cancelado na Central:\n\n${desc}`;
  return `${await pushNow(deps, ctx, before.id, "delete")}\n\n${desc}`;
}

/** Envia ao Google agora e só relata sucesso depois da resposta dele. */
async function pushNow(deps: BotDeps, ctx: RequestContext, eventId: string, kind: "upsert" | "delete") {
  try {
    // Relógio real: a fila é gravada com Date.now().
    await processJobs({ db: deps.db, env: deps.env }, { workspaceId: ctx.workspaceId, eventId });
  } catch (e) {
    console.error("telegram push", e);
  }
  const job = await deps.db.query.syncJobs.findFirst({ where: eq(syncJobs.eventId, eventId), orderBy: desc(syncJobs.updatedAt) });
  const status = job?.status ?? "pending";
  if (status === "done") return kind === "upsert" ? "Agendado na Central e no Google Agenda:" : "Cancelado na Central e no Google Agenda:";
  if (status === "failed")
    return kind === "upsert"
      ? `Salvo na Central, mas o Google Agenda recusou (${job?.error ?? "erro"}). O compromisso aparece com erro na Central:`
      : `Cancelado na Central, mas o Google Agenda recusou (${job?.error ?? "erro"}):`;
  return kind === "upsert"
    ? "Salvo na Central. O Google Agenda ainda não confirmou; vou tentar de novo sozinho e o compromisso aparece como pendente até lá:"
    : "Cancelado na Central. O Google Agenda ainda não confirmou; vou tentar de novo sozinho:";
}

// ---------- Resumo diário ----------

/** Manda o resumo do dia para quem ligou o Telegram e deixou o resumo ativo. Dias vazios não geram mensagem. */
export async function sendDailySummaries(deps: BotDeps) {
  if (!telegramEnabled(deps.env)) return 0;
  const now = deps.now?.() ?? Date.now();
  const links = await deps.db.select().from(telegramLinks).where(eq(telegramLinks.dailySummary, true));
  let sent = 0;
  for (const link of links) {
    const ctx = await contextFor(deps.db, link);
    if (!ctx) continue;
    const text = await todaySummary(ctx, now, { skipEmpty: true });
    if (!text) continue;
    await say(deps, link.chatId, `Bom dia! ${text}`);
    sent++;
  }
  // Limpeza: updates antigos, códigos e confirmações vencidos.
  await deps.db.batch([
    deps.db.delete(processedUpdates).where(lte(processedUpdates.processedAt, now - 7 * 86_400_000)),
    deps.db.delete(telegramLinkCodes).where(lt(telegramLinkCodes.expiresAt, now)),
    deps.db.delete(pendingConfirmations).where(lt(pendingConfirmations.expiresAt, now - 86_400_000)),
  ]);
  return sent;
}

