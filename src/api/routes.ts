import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Hono, type Context } from "hono";
import { enqueueStatements, processJobs } from "../integrations/calendar-sync";
import { attachments, auditLog, events, ideas, memberships, users, ideaStatuses, ideaTags, priorities, projects, projectStatuses, tags, tasks, taskStatuses } from "../db/schema";
import { newId } from "../lib/crypto";
import { eventView, listOccurrences, type EventRow } from "../lib/occurrences";
import { isOccurrence, seriesEnd, toRRule } from "../lib/recurrence";
import { localDayRange, toIso } from "../lib/time";
import type { z } from "zod";
import { requireMember, requireRole, type AppEnv, type RequestContext } from "./context";
import {
  auditInsert,
  ensureMember,
  ensureRef,
  likePattern,
  notFound,
  parseBody,
  serialize,
  toUtc,
  ValidationError,
} from "./helpers";
import { deleteEventStatements } from "./event-delete";
import { registerNotes } from "./notes";
import { registerSecretary } from "./secretary";
import { registerTaskDetails } from "./task-details";
import * as s from "./schemas";

export const api = new Hono<AppEnv>();
api.use("*", requireMember);
registerNotes(api);
registerTaskDetails(api);
registerSecretary(api);

const LIST_LIMIT = 500;

function matches(q: string | undefined, ...cols: SQLiteColumn[]): SQL | undefined {
  if (!q?.trim()) return undefined;
  const p = likePattern(q.trim());
  return or(...cols.map((col) => sql`${col} LIKE ${p} ESCAPE '\\'`));
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new ValidationError([{ path: field, message: "valor inválido" }]);
  return value as T;
}

// ---------- Projetos ----------

api.get("/projects", async (c) => {
  const ctx = c.get("ctx");
  const rows = await ctx.db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, ctx.workspaceId),
        c.req.query("status") ? eq(projects.status, oneOf(c.req.query("status"), projectStatuses, "status")!) : undefined,
        matches(c.req.query("q"), projects.title, projects.description),
      ),
    )
    .orderBy(desc(projects.updatedAt))
    .limit(LIST_LIMIT);
  return c.json(rows.map(serialize));
});

api.post("/projects", async (c) => {
  const ctx = c.get("ctx");
  const body = await parseBody(c, s.projectCreate);
  const row = { id: newId(), workspaceId: ctx.workspaceId, createdBy: ctx.userId, ...body };
  await ctx.db.batch([ctx.db.insert(projects).values(row), auditInsert(ctx, "project", row.id, "create", null, body)]);
  return c.json(serialize(await getProject(ctx, row.id)), 201);
});

api.get("/projects/:id", async (c) => c.json(serialize(await getProject(c.get("ctx"), c.req.param("id")))));

api.patch("/projects/:id", async (c) => {
  const ctx = c.get("ctx");
  const before = await getProject(ctx, c.req.param("id"));
  const body = await parseBody(c, s.projectUpdate);
  await ctx.db.batch([
    ctx.db
      .update(projects)
      .set({ ...body, updatedAt: Date.now() })
      .where(and(eq(projects.id, before.id), eq(projects.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "project", before.id, "update", pick(before, body), body),
  ]);
  return c.json(serialize(await getProject(ctx, before.id)));
});

api.delete("/projects/:id", async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const before = await getProject(ctx, c.req.param("id"));
  await ctx.db.batch([
    ctx.db.delete(projects).where(and(eq(projects.id, before.id), eq(projects.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "project", before.id, "delete", before, null),
    ctx.db.delete(attachments).where(and(eq(attachments.workspaceId, ctx.workspaceId), eq(attachments.parentKind, "project"), eq(attachments.parentId, before.id))),
  ]);
  return c.body(null, 204);
});

async function getProject(ctx: RequestContext, id: string) {
  const row = await ctx.db.query.projects.findFirst({
    where: and(eq(projects.id, id), eq(projects.workspaceId, ctx.workspaceId)),
  });
  return row ?? notFound();
}

// ---------- Tarefas ----------

api.get("/tasks", async (c) => {
  const ctx = c.get("ctx");
  const q = c.req.query();
  const from = toUtc(ctx, q.dueFrom, "dueFrom");
  const to = toUtc(ctx, q.dueTo, "dueTo");
  const rows = await ctx.db
    .select({
      ...getTableColumns(tasks),
      checklistTotal: sql<number>`(SELECT count(*) FROM task_items WHERE task_items.task_id = "tasks"."id")`,
      checklistDone: sql<number>`(SELECT count(*) FROM task_items WHERE task_items.task_id = "tasks"."id" AND task_items.done = 1)`,
      commentCount: sql<number>`(SELECT count(*) FROM task_comments WHERE task_comments.task_id = "tasks"."id")`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, ctx.workspaceId),
        q.status ? eq(tasks.status, oneOf(q.status, taskStatuses, "status")!) : undefined,
        q.priority ? eq(tasks.priority, oneOf(q.priority, priorities, "priority")!) : undefined,
        q.projectId ? eq(tasks.projectId, q.projectId) : undefined,
        q.assigneeId ? eq(tasks.assigneeId, q.assigneeId) : undefined,
        from != null ? gte(tasks.dueAt, from) : undefined,
        to != null ? lt(tasks.dueAt, to) : undefined,
        matches(q.q, tasks.title, tasks.description),
      ),
    )
    .orderBy(sql`${tasks.dueAt} IS NULL`, asc(tasks.dueAt), desc(tasks.updatedAt))
    .limit(LIST_LIMIT);
  return c.json(rows.map(serialize));
});

api.post("/tasks", async (c) => {
  const ctx = c.get("ctx");
  const body = await parseBody(c, s.taskCreate);
  await checkTaskRefs(ctx, body);
  const values = { ...body, dueAt: toUtc(ctx, body.dueAt, "dueAt") };
  const row = { id: newId(), workspaceId: ctx.workspaceId, createdBy: ctx.userId, ...values };
  await ctx.db.batch([ctx.db.insert(tasks).values(row), auditInsert(ctx, "task", row.id, "create", null, values)]);
  return c.json(serialize(await getTask(ctx, row.id)), 201);
});

api.get("/tasks/:id", async (c) => c.json(serialize(await getTask(c.get("ctx"), c.req.param("id")))));

api.patch("/tasks/:id", async (c) => {
  const ctx = c.get("ctx");
  const before = await getTask(ctx, c.req.param("id"));
  const body = await parseBody(c, s.taskUpdate);
  await checkTaskRefs(ctx, body);
  const { dueAt, ...rest } = body;
  const values = dueAt === undefined ? rest : { ...rest, dueAt: toUtc(ctx, dueAt, "dueAt") };
  await ctx.db.batch([
    ctx.db
      .update(tasks)
      .set({ ...values, updatedAt: Date.now() })
      .where(and(eq(tasks.id, before.id), eq(tasks.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "task", before.id, "update", pick(before, values), values),
  ]);
  return c.json(serialize(await getTask(ctx, before.id)));
});

api.delete("/tasks/:id", async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const before = await getTask(ctx, c.req.param("id"));
  await ctx.db.batch([
    ctx.db.delete(tasks).where(and(eq(tasks.id, before.id), eq(tasks.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "task", before.id, "delete", before, null),
    ctx.db.delete(attachments).where(and(eq(attachments.workspaceId, ctx.workspaceId), eq(attachments.parentKind, "task"), eq(attachments.parentId, before.id))),
  ]);
  return c.body(null, 204);
});

async function checkTaskRefs(ctx: RequestContext, body: { projectId?: string | null; assigneeId?: string | null; sourceEventId?: string | null }) {
  await ensureRef(ctx, projects, body.projectId, "projectId");
  await ensureRef(ctx, events, body.sourceEventId, "sourceEventId");
  await ensureMember(ctx, body.assigneeId, "assigneeId");
}

async function getTask(ctx: RequestContext, id: string) {
  const row = await ctx.db.query.tasks.findFirst({ where: and(eq(tasks.id, id), eq(tasks.workspaceId, ctx.workspaceId)) });
  return row ?? notFound();
}

// ---------- Ideias ----------

api.get("/ideas", async (c) => {
  const ctx = c.get("ctx");
  const q = c.req.query();
  const rows = await ctx.db
    .select()
    .from(ideas)
    .where(
      and(
        eq(ideas.workspaceId, ctx.workspaceId),
        q.status ? eq(ideas.status, oneOf(q.status, ideaStatuses, "status")!) : undefined,
        q.category ? eq(ideas.category, q.category) : undefined,
        matches(q.q, ideas.title, ideas.description),
      ),
    )
    .orderBy(desc(ideas.updatedAt))
    .limit(LIST_LIMIT);
  return c.json(await withTags(ctx, rows));
});

api.post("/ideas", async (c) => {
  const ctx = c.get("ctx");
  const { tags: tagNames, ...body } = await parseBody(c, s.ideaCreate);
  const row = { id: newId(), workspaceId: ctx.workspaceId, createdBy: ctx.userId, ...body };
  await ctx.db.batch([
    ctx.db.insert(ideas).values(row),
    auditInsert(ctx, "idea", row.id, "create", null, { ...body, tags: tagNames }),
  ]);
  if (tagNames) await setTags(ctx, row.id, tagNames);
  return c.json((await withTags(ctx, [await getIdea(ctx, row.id)]))[0], 201);
});

api.get("/ideas/:id", async (c) => {
  const ctx = c.get("ctx");
  return c.json((await withTags(ctx, [await getIdea(ctx, c.req.param("id"))]))[0]);
});

api.patch("/ideas/:id", async (c) => {
  const ctx = c.get("ctx");
  const before = await getIdea(ctx, c.req.param("id"));
  const { tags: tagNames, ...body } = await parseBody(c, s.ideaUpdate);
  await ctx.db.batch([
    ctx.db
      .update(ideas)
      .set({ ...body, updatedAt: Date.now() })
      .where(and(eq(ideas.id, before.id), eq(ideas.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "idea", before.id, "update", pick(before, body), { ...body, tags: tagNames }),
  ]);
  if (tagNames) await setTags(ctx, before.id, tagNames);
  return c.json((await withTags(ctx, [await getIdea(ctx, before.id)]))[0]);
});

api.delete("/ideas/:id", async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const before = await getIdea(ctx, c.req.param("id"));
  await ctx.db.batch([
    ctx.db.delete(ideas).where(and(eq(ideas.id, before.id), eq(ideas.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "idea", before.id, "delete", before, null),
    ctx.db.delete(attachments).where(and(eq(attachments.workspaceId, ctx.workspaceId), eq(attachments.parentKind, "idea"), eq(attachments.parentId, before.id))),
  ]);
  return c.body(null, 204);
});

/** Converte a ideia em tarefa ou projeto, preservando a origem (source_idea_id). */
api.post("/ideas/:id/convert", async (c) => {
  const ctx = c.get("ctx");
  const idea = await getIdea(ctx, c.req.param("id"));
  if (idea.status === "converted") return c.json({ error: "ideia já convertida", convertedToId: idea.convertedToId }, 409);
  const body = await parseBody(c, s.ideaConvert);
  const targetId = newId();
  const base = {
    id: targetId,
    workspaceId: ctx.workspaceId,
    title: idea.title,
    description: idea.description,
    priority: body.priority,
    sourceIdeaId: idea.id,
    createdBy: ctx.userId,
  };
  let insert;
  if (body.to === "task") {
    await ensureRef(ctx, projects, body.projectId, "projectId");
    insert = ctx.db.insert(tasks).values({ ...base, projectId: body.projectId });
  } else {
    if (body.projectId) throw new ValidationError([{ path: "projectId", message: "só vale para tarefa" }]);
    insert = ctx.db.insert(projects).values(base);
  }
  // A condição status != converted evita conversão dupla em requisições simultâneas.
  const [, updated] = await ctx.db.batch([
    insert,
    ctx.db
      .update(ideas)
      .set({ status: "converted", convertedToKind: body.to, convertedToId: targetId, updatedAt: Date.now() })
      .where(and(eq(ideas.id, idea.id), eq(ideas.workspaceId, ctx.workspaceId), ne(ideas.status, "converted"))),
    auditInsert(ctx, body.to, targetId, "create", null, { sourceIdeaId: idea.id }),
    auditInsert(ctx, "idea", idea.id, "convert", { status: idea.status }, { status: "converted", to: body.to, id: targetId }),
  ]);
  if (updated.meta.changes === 0) {
    // Outra requisição converteu antes: desfaz o registro criado.
    const table = body.to === "task" ? tasks : projects;
    await ctx.db.batch([
      ctx.db.delete(table).where(eq(table.id, targetId)),
      ctx.db
        .delete(auditLog)
        .where(or(eq(auditLog.entityId, targetId), and(eq(auditLog.entityId, idea.id), sql`json_extract(${auditLog.after}, '$.id') = ${targetId}`))),
    ]);
    return c.json({ error: "ideia já convertida" }, 409);
  }
  const target = body.to === "task" ? await getTask(ctx, targetId) : await getProject(ctx, targetId);
  return c.json({ kind: body.to, record: serialize(target) }, 201);
});

async function getIdea(ctx: RequestContext, id: string) {
  const row = await ctx.db.query.ideas.findFirst({ where: and(eq(ideas.id, id), eq(ideas.workspaceId, ctx.workspaceId)) });
  return row ?? notFound();
}

async function setTags(ctx: RequestContext, ideaId: string, names: string[]) {
  const unique = [...new Set(names.map((n) => n.toLowerCase()))];
  const stmts: any[] = [ctx.db.delete(ideaTags).where(eq(ideaTags.ideaId, ideaId))];
  for (const name of unique) {
    stmts.push(ctx.db.insert(tags).values({ id: newId(), workspaceId: ctx.workspaceId, name }).onConflictDoNothing());
  }
  if (unique.length) {
    stmts.push(
      ctx.db.insert(ideaTags).select(
        ctx.db
          .select({ ideaId: sql`${ideaId}`.as("idea_id"), tagId: tags.id })
          .from(tags)
          .where(and(eq(tags.workspaceId, ctx.workspaceId), inArray(tags.name, unique))),
      ),
    );
  }
  await ctx.db.batch(stmts as [any, ...any[]]);
}

async function withTags(ctx: RequestContext, rows: (typeof ideas.$inferSelect)[]) {
  if (!rows.length) return [];
  const links = await ctx.db
    .select({ ideaId: ideaTags.ideaId, name: tags.name })
    .from(ideaTags)
    .innerJoin(tags, eq(tags.id, ideaTags.tagId))
    .where(inArray(ideaTags.ideaId, rows.map((r) => r.id)));
  return rows.map((r) => ({
    ...serialize(r),
    tags: links.filter((l) => l.ideaId === r.id).map((l) => l.name).sort(),
  }));
}

// ---------- Compromissos ----------

const YEAR = 365 * 86_400_000;

/** Lista a agenda com as séries expandidas. Sem intervalo, cobre um ano para trás e um para frente. */
api.get("/events", async (c) => {
  const ctx = c.get("ctx");
  const now = Date.now();
  const from = toUtc(ctx, c.req.query("from"), "from") ?? now - YEAR;
  const to = toUtc(ctx, c.req.query("to"), "to") ?? now + YEAR;
  if (to - from > 2 * YEAR + 86_400_000) throw new ValidationError([{ path: "to", message: "intervalo máximo de 2 anos" }]);
  const rows = await listOccurrences(ctx.db, ctx.workspaceId, from, to, matches(c.req.query("q"), events.title, events.description));
  return c.json(rows.slice(0, LIST_LIMIT).map(eventView));
});

/** Regra de repetição e fim da série a partir da escolha da tela. */
function seriesFields(ctx: RequestContext, repeat: z.infer<typeof s.repeat> | null | undefined, startAt: number, endAt: number, allDay: boolean) {
  if (!repeat) return { recurrence: null, recurrenceEndsAt: null };
  if (repeat.until) {
    const until = toUtc(ctx, `${repeat.until}T23:59`, "repeat.until")!;
    if (until < startAt) throw new ValidationError([{ path: "repeat.until", message: "a data final é antes do primeiro dia" }]);
  }
  const recurrence = toRRule(repeat, startAt, ctx.timezone, allDay);
  return { recurrence, recurrenceEndsAt: seriesEnd({ startAt, endAt, timezone: ctx.timezone, allDay, recurrence }) };
}

api.post("/events", async (c) => {
  const ctx = c.get("ctx");
  const { repeat, ...body } = await parseBody(c, s.eventCreate);
  await ensureRef(ctx, projects, body.projectId, "projectId");
  const startAt = toUtc(ctx, body.startAt, "startAt")!;
  const endAt = toUtc(ctx, body.endAt, "endAt")!;
  checkRange(startAt, endAt);
  const values = { ...body, startAt, endAt, timezone: ctx.timezone, ...seriesFields(ctx, repeat, startAt, endAt, !!body.allDay) };
  const row = { id: newId(), workspaceId: ctx.workspaceId, createdBy: ctx.userId, ...values };
  const sync = await enqueueStatements(ctx.db, ctx.workspaceId, { id: row.id, calendarId: null, remoteId: null }, "event.upsert");
  await ctx.db.batch([ctx.db.insert(events).values(row), auditInsert(ctx, "event", row.id, "create", null, values), ...sync]);
  if (sync.length) pushSoon(c);
  return c.json({ ...eventView(await getEvent(ctx, row.id)), conflicts: await conflicts(ctx, row.id, startAt, endAt) }, 201);
});

api.get("/events/:id", async (c) => c.json(eventView(await getEvent(c.get("ctx"), c.req.param("id")))));

/** Edita o compromisso ou, numa série, todas as ocorrências. */
api.patch("/events/:id", async (c) => {
  const ctx = c.get("ctx");
  const before = await getEvent(ctx, c.req.param("id"));
  const { repeat, ...body } = await parseBody(c, s.eventUpdate);
  if (repeat && before.seriesId) throw new ValidationError([{ path: "repeat", message: "uma ocorrência avulsa não pode repetir" }]);
  await ensureRef(ctx, projects, body.projectId, "projectId");
  const startAt = body.startAt !== undefined ? toUtc(ctx, body.startAt, "startAt")! : before.startAt;
  const endAt = body.endAt !== undefined ? toUtc(ctx, body.endAt, "endAt")! : before.endAt;
  const allDay = body.allDay ?? before.allDay;
  checkRange(startAt, endAt);
  let series = {};
  if (repeat !== undefined) series = seriesFields(ctx, repeat, startAt, endAt, allDay);
  else if (before.recurrence && (startAt !== before.startAt || endAt !== before.endAt || allDay !== before.allDay)) {
    series = { recurrenceEndsAt: seriesEnd({ startAt, endAt, timezone: before.timezone, allDay, recurrence: before.recurrence }) };
  }
  // Mudar o horário da série invalida as datas excluídas, que apontam para o horário antigo.
  const exdates = before.recurrence && startAt !== before.startAt ? { exdates: null } : {};
  const values = { ...body, startAt, endAt, ...series, ...exdates };
  const sync = await enqueueStatements(ctx.db, ctx.workspaceId, before, "event.upsert");
  await ctx.db.batch([
    ctx.db
      .update(events)
      .set({ ...values, updatedAt: Date.now() })
      .where(and(eq(events.id, before.id), eq(events.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "event", before.id, "update", pick(before, values), values),
    ...sync,
  ]);
  if (sync.length) pushSoon(c);
  return c.json({ ...eventView(await getEvent(ctx, before.id)), conflicts: await conflicts(ctx, before.id, startAt, endAt) });
});

/** Início original de uma ocorrência válida da série. */
function occurrenceOf(ctx: RequestContext, master: EventRow, value: string) {
  if (!master.recurrence) throw new ValidationError([{ path: "occurrenceStart", message: "o compromisso não se repete" }]);
  const start = toUtc(ctx, value, "occurrenceStart")!;
  if (!isOccurrence({ ...master, recurrence: master.recurrence }, start)) throw new ValidationError([{ path: "occurrenceStart", message: "essa data não faz parte da série" }]);
  return start;
}

/** Tira uma ocorrência da série (a série continua). */
api.post("/events/:id/occurrences/skip", async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const master = await getEvent(ctx, c.req.param("id"));
  const body = await parseBody(c, s.occurrenceSkip);
  const start = occurrenceOf(ctx, master, body.occurrenceStart);
  const exdates = [...new Set([...(master.exdates ?? []), start])].sort((a, b) => a - b);
  const sync = await enqueueStatements(ctx.db, ctx.workspaceId, master, "event.upsert");
  await ctx.db.batch([
    ctx.db.update(events).set({ exdates, updatedAt: Date.now() }).where(and(eq(events.id, master.id), eq(events.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "event", master.id, "update", { exdates: master.exdates }, { exdates, skipped: start }),
    ...sync,
  ]);
  if (sync.length) pushSoon(c);
  return c.json(eventView(await getEvent(ctx, master.id)));
});

/**
 * Altera só uma ocorrência: ela vira um compromisso próprio ligado à série (seriesId) e sai da
 * repetição (data excluída). No Google aparece como um evento avulso naquele dia.
 */
api.post("/events/:id/occurrences/detach", async (c) => {
  const ctx = c.get("ctx");
  const master = await getEvent(ctx, c.req.param("id"));
  const { occurrenceStart, ...body } = await parseBody(c, s.occurrenceDetach);
  const original = occurrenceOf(ctx, master, occurrenceStart);
  await ensureRef(ctx, projects, body.projectId, "projectId");
  const duration = master.endAt - master.startAt;
  const startAt = body.startAt !== undefined ? toUtc(ctx, body.startAt, "startAt")! : original;
  const endAt = body.endAt !== undefined ? toUtc(ctx, body.endAt, "endAt")! : startAt + duration;
  checkRange(startAt, endAt);
  const row = {
    id: newId(),
    workspaceId: ctx.workspaceId,
    title: body.title ?? master.title,
    description: body.description !== undefined ? body.description : master.description,
    projectId: body.projectId !== undefined ? body.projectId : master.projectId,
    reminderMinutes: body.reminderMinutes !== undefined ? body.reminderMinutes : master.reminderMinutes,
    startAt,
    endAt,
    allDay: master.allDay,
    timezone: master.timezone,
    calendarId: master.calendarId,
    seriesId: master.id,
    originalStartAt: original,
    createdBy: ctx.userId,
  };
  const exdates = [...new Set([...(master.exdates ?? []), original])].sort((a, b) => a - b);
  const [syncMaster, syncOne] = await Promise.all([
    enqueueStatements(ctx.db, ctx.workspaceId, master, "event.upsert"),
    enqueueStatements(ctx.db, ctx.workspaceId, { id: row.id, calendarId: master.calendarId, remoteId: null }, "event.upsert"),
  ]);
  await ctx.db.batch([
    ctx.db.insert(events).values(row),
    ctx.db.update(events).set({ exdates, updatedAt: Date.now() }).where(and(eq(events.id, master.id), eq(events.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "event", row.id, "create", null, { ...row, via: "ocorrência" }),
    ...syncMaster,
    ...syncOne,
  ]);
  if (syncMaster.length || syncOne.length) pushSoon(c);
  return c.json({ ...eventView(await getEvent(ctx, row.id)), conflicts: await conflicts(ctx, row.id, startAt, endAt) }, 201);
});

/** Exclui o compromisso; numa série, exclui a série inteira. */
api.delete("/events/:id", async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const before = await getEvent(ctx, c.req.param("id"));
  const stmts = await deleteEventStatements(ctx, before);
  await ctx.db.batch(stmts as [any, ...any[]]);
  if (stmts.length > 3) pushSoon(c);
  return c.body(null, 204);
});

/** Envia a fila ao Google logo após responder, sem esperar o cron. */
function pushSoon(c: Context<AppEnv>) {
  if (c.env.PUSH_ON_WRITE === "false") return;
  const ctx = c.get("ctx");
  try {
    c.executionCtx.waitUntil(processJobs({ db: ctx.db, env: c.env }, { workspaceId: ctx.workspaceId }).catch((e) => console.error("sync", e)));
  } catch {
    // Sem ExecutionContext (ex.: alguns testes): o cron envia depois.
  }
}

function checkRange(startAt: number, endAt: number) {
  if (endAt < startAt) throw new ValidationError([{ path: "endAt", message: "término antes do início" }]);
}

/** Compromissos (e ocorrências) que se sobrepõem ao horário, fora a própria série. */
async function conflicts(ctx: RequestContext, id: string, startAt: number, endAt: number) {
  const rows = await listOccurrences(ctx.db, ctx.workspaceId, startAt, Math.max(endAt, startAt + 1));
  return rows
    .filter((e) => e.id !== id && e.seriesId !== id && e.startAt < endAt && e.endAt > startAt)
    .map((e) => ({ id: e.id, title: e.title, startAt: toIso(e.startAt), endAt: toIso(e.endAt) }));
}

async function getEvent(ctx: RequestContext, id: string) {
  const row = await ctx.db.query.events.findFirst({ where: and(eq(events.id, id), eq(events.workspaceId, ctx.workspaceId)) });
  return row ?? notFound();
}

// ---------- Membros ----------

api.get("/members", async (c) => {
  const ctx = c.get("ctx");
  const rows = await ctx.db
    .select({ id: users.id, email: users.email, name: users.name, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, ctx.workspaceId))
    .orderBy(asc(users.email));
  return c.json(rows);
});

// ---------- Painel e busca ----------

api.get("/dashboard", async (c) => {
  const ctx = c.get("ctx");
  const now = Date.now();
  const [dayStart, dayEnd] = localDayRange(now, ctx.timezone);
  const count = sql<number>`count(*)`;
  const eventsToday = await listOccurrences(ctx.db, ctx.workspaceId, dayStart, dayEnd);
  const [byStatus, overdue, dueToday, newIdeas, activeProjects] = await ctx.db.batch([
    ctx.db.select({ status: tasks.status, n: count }).from(tasks).where(eq(tasks.workspaceId, ctx.workspaceId)).groupBy(tasks.status),
    ctx.db.select({ n: count }).from(tasks).where(and(eq(tasks.workspaceId, ctx.workspaceId), ne(tasks.status, "done"), lt(tasks.dueAt, now))),
    ctx.db.select({ n: count }).from(tasks).where(and(eq(tasks.workspaceId, ctx.workspaceId), ne(tasks.status, "done"), gte(tasks.dueAt, dayStart), lt(tasks.dueAt, dayEnd))),
    ctx.db.select({ n: count }).from(ideas).where(and(eq(ideas.workspaceId, ctx.workspaceId), eq(ideas.status, "new"))),
    ctx.db.select({ n: count }).from(projects).where(and(eq(projects.workspaceId, ctx.workspaceId), eq(projects.status, "active"))),
  ]);
  return c.json({
    tasksByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    overdueTasks: overdue[0].n,
    tasksDueToday: dueToday[0].n,
    eventsToday: eventsToday.map(eventView),
    newIdeas: newIdeas[0].n,
    activeProjects: activeProjects[0].n,
  });
});

api.get("/search", async (c) => {
  const ctx = c.get("ctx");
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ tasks: [], projects: [], ideas: [], events: [] });
  const [t, p, i, e] = await ctx.db.batch([
    ctx.db.select().from(tasks).where(and(eq(tasks.workspaceId, ctx.workspaceId), matches(q, tasks.title, tasks.description))).limit(20),
    ctx.db.select().from(projects).where(and(eq(projects.workspaceId, ctx.workspaceId), matches(q, projects.title, projects.description))).limit(20),
    ctx.db.select().from(ideas).where(and(eq(ideas.workspaceId, ctx.workspaceId), matches(q, ideas.title, ideas.description))).limit(20),
    ctx.db.select().from(events).where(and(eq(events.workspaceId, ctx.workspaceId), matches(q, events.title, events.description))).limit(20),
  ]);
  return c.json({ tasks: t.map(serialize), projects: p.map(serialize), ideas: i.map(serialize), events: e.map(eventView) });
});

/** Valores anteriores só dos campos alterados, para a auditoria. */
function pick(before: Record<string, unknown>, changes: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(changes).filter((k) => k in before).map((k) => [k, before[k]]));
}
