import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { events, meetingNotes, priorities, tasks, type Decision } from "../db/schema";
import { newId } from "../lib/crypto";
import { formatLocal } from "../lib/time";
import type { AppEnv, RequestContext } from "./context";
import { auditInsert, ensureMember, notFound, parseBody, serialize, toUtc } from "./helpers";

const notesBody = z.strictObject({
  agenda: z.string().max(20_000).nullable().optional(),
  summary: z.string().max(20_000).nullable().optional(),
  decisions: z
    .array(z.strictObject({ id: z.string().min(1).max(64).optional(), text: z.string().trim().min(1, "decisão vazia").max(1000) }))
    .max(100)
    .optional(),
});

const decisionTask = z.strictObject({
  priority: z.enum(priorities).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  dueAt: z.string().min(10).max(40).nullable().optional(),
});

async function getEvent(ctx: RequestContext, id: string) {
  const ev = await ctx.db.query.events.findFirst({ where: and(eq(events.id, id), eq(events.workspaceId, ctx.workspaceId)) });
  return ev ?? notFound();
}

async function getNote(ctx: RequestContext, eventId: string) {
  return ctx.db.query.meetingNotes.findFirst({ where: and(eq(meetingNotes.eventId, eventId), eq(meetingNotes.workspaceId, ctx.workspaceId)) });
}

function view(eventId: string, note: typeof meetingNotes.$inferSelect | undefined) {
  if (!note) return { eventId, agenda: null, summary: null, decisions: [], updatedAt: null };
  return serialize({ eventId, agenda: note.agenda, summary: note.summary, decisions: note.decisions, updatedAt: note.updatedAt });
}

export function registerNotes(api: Hono<AppEnv>) {
  api.get("/events/:id/notes", async (c) => {
    const ctx = c.get("ctx");
    const ev = await getEvent(ctx, c.req.param("id"));
    return c.json(view(ev.id, await getNote(ctx, ev.id)));
  });

  /** Salva pauta, resumo e decisões. O vínculo decisão → tarefa é mantido pelo servidor. */
  api.put("/events/:id/notes", async (c) => {
    const ctx = c.get("ctx");
    const ev = await getEvent(ctx, c.req.param("id"));
    const body = await parseBody(c, notesBody);
    const before = await getNote(ctx, ev.id);
    const previous = new Map((before?.decisions ?? []).map((d) => [d.id, d]));
    const decisions: Decision[] = (body.decisions ?? before?.decisions ?? []).map((d) => {
      const old = d.id ? previous.get(d.id) : undefined;
      return { id: old?.id ?? newId(), text: d.text, taskId: old?.taskId ?? null };
    });
    const values = {
      agenda: body.agenda !== undefined ? body.agenda : (before?.agenda ?? null),
      summary: body.summary !== undefined ? body.summary : (before?.summary ?? null),
      decisions,
      updatedBy: ctx.userId,
      updatedAt: Date.now(),
    };
    await ctx.db.batch([
      ctx.db
        .insert(meetingNotes)
        .values({ eventId: ev.id, workspaceId: ctx.workspaceId, ...values })
        .onConflictDoUpdate({ target: meetingNotes.eventId, set: values }),
      auditInsert(ctx, "meeting_notes", ev.id, before ? "update" : "create", before ? { agenda: before.agenda, summary: before.summary, decisions: before.decisions } : null, { agenda: values.agenda, summary: values.summary, decisions }),
    ]);
    return c.json(view(ev.id, await getNote(ctx, ev.id)));
  });

  /** Transforma uma decisão em tarefa ligada ao compromisso (source_event_id) e ao projeto dele. */
  api.post("/events/:id/notes/decisions/:decisionId/task", async (c) => {
    const ctx = c.get("ctx");
    const ev = await getEvent(ctx, c.req.param("id"));
    const note = await getNote(ctx, ev.id);
    const decision = note?.decisions.find((d) => d.id === c.req.param("decisionId"));
    if (!note || !decision) notFound();
    if (decision.taskId) {
      const existing = await ctx.db.query.tasks.findFirst({ where: and(eq(tasks.id, decision.taskId), eq(tasks.workspaceId, ctx.workspaceId)) });
      if (existing) return c.json({ error: "decisão já virou tarefa", taskId: decision.taskId }, 409);
    }
    const body = await parseBody(c, decisionTask);
    await ensureMember(ctx, body.assigneeId, "assigneeId");
    const taskId = newId();
    const task = {
      id: taskId,
      workspaceId: ctx.workspaceId,
      title: decision.text.slice(0, 200),
      description: `Decisão da reunião “${ev.title}” de ${formatLocal(ev.startAt, ev.timezone)}.`,
      projectId: ev.projectId,
      priority: body.priority,
      assigneeId: body.assigneeId ?? null,
      dueAt: toUtc(ctx, body.dueAt, "dueAt") ?? null,
      sourceEventId: ev.id,
      createdBy: ctx.userId,
    };
    const decisions = note.decisions.map((d) => (d.id === decision.id ? { ...d, taskId } : d));
    const updated = await ctx.db.batch([
      ctx.db.insert(tasks).values(task),
      ctx.db
        .update(meetingNotes)
        .set({ decisions, updatedAt: Date.now(), updatedBy: ctx.userId })
        .where(and(eq(meetingNotes.eventId, ev.id), eq(meetingNotes.updatedAt, note.updatedAt))),
      auditInsert(ctx, "task", taskId, "create", null, { sourceEventId: ev.id, decisionId: decision.id }),
    ]);
    if (updated[1].meta.changes === 0) {
      // O registro mudou no meio do caminho (outra pessoa salvou): desfaz para não perder o vínculo.
      await ctx.db.delete(tasks).where(eq(tasks.id, taskId));
      return c.json({ error: "o registro foi alterado; recarregue e tente de novo" }, 409);
    }
    const saved = await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    return c.json({ task: serialize(saved!), notes: view(ev.id, await getNote(ctx, ev.id)) }, 201);
  });
}
