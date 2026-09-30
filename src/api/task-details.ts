import { and, asc, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auditLog, taskComments, taskItems, tasks, users } from "../db/schema";
import { newId } from "../lib/crypto";
import type { AppEnv, RequestContext } from "./context";
import { auditInsert, notFound, parseBody, serialize, ValidationError } from "./helpers";

// Checklist, comentários e histórico de uma tarefa. As mudanças entram no audit_log
// com entityId = id da tarefa, para o histórico sair numa consulta só.

const MAX_ITEMS = 200;
const HISTORY_LIMIT = 200;

const itemCreate = z.strictObject({ text: z.string().trim().min(1, "item vazio").max(500) });
const itemUpdate = z.strictObject({ text: z.string().trim().min(1, "item vazio").max(500).optional(), done: z.boolean().optional() });
const itemOrder = z.strictObject({ ids: z.array(z.string().min(1).max(64)).max(MAX_ITEMS) });
const commentBody = z.strictObject({ body: z.string().trim().min(1, "comentário vazio").max(5000) });

async function getTask(ctx: RequestContext, id: string) {
  const row = await ctx.db.query.tasks.findFirst({ columns: { id: true }, where: and(eq(tasks.id, id), eq(tasks.workspaceId, ctx.workspaceId)) });
  return row ?? notFound();
}

async function getItem(ctx: RequestContext, taskId: string, id: string) {
  const row = await ctx.db.query.taskItems.findFirst({
    where: and(eq(taskItems.id, id), eq(taskItems.taskId, taskId), eq(taskItems.workspaceId, ctx.workspaceId)),
  });
  return row ?? notFound();
}

async function getComment(ctx: RequestContext, taskId: string, id: string) {
  const row = await ctx.db.query.taskComments.findFirst({
    where: and(eq(taskComments.id, id), eq(taskComments.taskId, taskId), eq(taskComments.workspaceId, ctx.workspaceId)),
  });
  return row ?? notFound();
}

const itemView = (i: typeof taskItems.$inferSelect) => ({ id: i.id, text: i.text, done: i.done, position: i.position });

async function listItems(ctx: RequestContext, taskId: string) {
  const rows = await ctx.db.select().from(taskItems).where(and(eq(taskItems.taskId, taskId), eq(taskItems.workspaceId, ctx.workspaceId))).orderBy(asc(taskItems.position), asc(taskItems.createdAt));
  return rows.map(itemView);
}

/** A tarefa mudou: atualiza o updatedAt para ela subir nas listas. */
const touch = (ctx: RequestContext, taskId: string) => ctx.db.update(tasks).set({ updatedAt: Date.now() }).where(eq(tasks.id, taskId));

export function registerTaskDetails(api: Hono<AppEnv>) {
  // ---------- Checklist ----------

  api.get("/tasks/:id/checklist", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    return c.json(await listItems(ctx, task.id));
  });

  api.post("/tasks/:id/checklist", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    const body = await parseBody(c, itemCreate);
    const [{ n, last }] = await ctx.db
      .select({ n: count(), last: max(taskItems.position) })
      .from(taskItems)
      .where(eq(taskItems.taskId, task.id));
    if (n >= MAX_ITEMS) throw new ValidationError([{ path: "text", message: `a checklist aceita até ${MAX_ITEMS} itens` }]);
    const row = { id: newId(), workspaceId: ctx.workspaceId, taskId: task.id, text: body.text, position: (last ?? -1) + 1 };
    await ctx.db.batch([ctx.db.insert(taskItems).values(row), touch(ctx, task.id), auditInsert(ctx, "task_item", task.id, "create", null, { itemId: row.id, text: row.text })]);
    return c.json(itemView(await getItem(ctx, task.id, row.id)), 201);
  });

  api.patch("/tasks/:id/checklist/:itemId", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    const before = await getItem(ctx, task.id, c.req.param("itemId"));
    const body = await parseBody(c, itemUpdate);
    const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && v !== before[k as keyof typeof body]));
    if (!Object.keys(changed).length) return c.json(itemView(before));
    const old = Object.fromEntries(Object.keys(changed).map((k) => [k, before[k as keyof typeof body]]));
    await ctx.db.batch([
      ctx.db.update(taskItems).set({ ...changed, updatedAt: Date.now() }).where(eq(taskItems.id, before.id)),
      touch(ctx, task.id),
      auditInsert(ctx, "task_item", task.id, "update", { itemId: before.id, text: before.text, ...old }, { itemId: before.id, ...changed }),
    ]);
    return c.json(itemView(await getItem(ctx, task.id, before.id)));
  });

  /** Nova ordem: `ids` com todos os itens da tarefa. */
  api.put("/tasks/:id/checklist/order", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    const { ids } = await parseBody(c, itemOrder);
    const current = await listItems(ctx, task.id);
    const known = new Set(current.map((i) => i.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
      throw new ValidationError([{ path: "ids", message: "a lista precisa ter todos os itens da checklist, uma vez cada" }]);
    }
    if (ids.length) await ctx.db.batch(ids.map((id, position) => ctx.db.update(taskItems).set({ position }).where(eq(taskItems.id, id))) as [any, ...any[]]);
    return c.json(await listItems(ctx, task.id));
  });

  api.delete("/tasks/:id/checklist/:itemId", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    const before = await getItem(ctx, task.id, c.req.param("itemId"));
    await ctx.db.batch([ctx.db.delete(taskItems).where(eq(taskItems.id, before.id)), touch(ctx, task.id), auditInsert(ctx, "task_item", task.id, "delete", { itemId: before.id, text: before.text }, null)]);
    return c.body(null, 204);
  });

  // ---------- Comentários ----------

  const commentView = (row: typeof taskComments.$inferSelect, author: { name: string | null; email: string } | undefined) =>
    serialize({ id: row.id, body: row.body, userId: row.userId, authorName: author?.name || author?.email || "Pessoa removida", createdAt: row.createdAt, updatedAt: row.updatedAt, edited: row.updatedAt > row.createdAt });

  async function listComments(ctx: RequestContext, taskId: string) {
    const rows = await ctx.db
      .select({ c: taskComments, name: users.name, email: users.email })
      .from(taskComments)
      .leftJoin(users, eq(users.id, taskComments.userId))
      .where(and(eq(taskComments.taskId, taskId), eq(taskComments.workspaceId, ctx.workspaceId)))
      .orderBy(asc(taskComments.createdAt));
    return rows.map((r) => commentView(r.c, r.email ? { name: r.name, email: r.email } : undefined));
  }

  async function oneComment(ctx: RequestContext, taskId: string, id: string) {
    return (await listComments(ctx, taskId)).find((x) => x.id === id)!;
  }

  api.get("/tasks/:id/comments", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    return c.json(await listComments(ctx, task.id));
  });

  api.post("/tasks/:id/comments", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    const { body } = await parseBody(c, commentBody);
    // Datas em ms na criação: "editado" compara com a edição, que também grava em ms.
    const at = Date.now();
    const row = { id: newId(), workspaceId: ctx.workspaceId, taskId: task.id, userId: ctx.userId, body, createdAt: at, updatedAt: at };
    await ctx.db.batch([ctx.db.insert(taskComments).values(row), touch(ctx, task.id), auditInsert(ctx, "task_comment", task.id, "create", null, { commentId: row.id, body })]);
    return c.json(await oneComment(ctx, task.id, row.id), 201);
  });

  /** Só quem escreveu edita o comentário. */
  api.patch("/tasks/:id/comments/:commentId", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    const before = await getComment(ctx, task.id, c.req.param("commentId"));
    if (before.userId !== ctx.userId) throw new HTTPException(403, { message: "só quem escreveu pode editar o comentário" });
    const { body } = await parseBody(c, commentBody);
    if (body !== before.body) {
      await ctx.db.batch([
        ctx.db.update(taskComments).set({ body, updatedAt: Math.max(Date.now(), before.createdAt + 1) }).where(eq(taskComments.id, before.id)),
        auditInsert(ctx, "task_comment", task.id, "update", { commentId: before.id, body: before.body }, { commentId: before.id, body }),
      ]);
    }
    return c.json(await oneComment(ctx, task.id, before.id));
  });

  /** Quem escreveu, o dono ou um administrador podem apagar. */
  api.delete("/tasks/:id/comments/:commentId", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    const before = await getComment(ctx, task.id, c.req.param("commentId"));
    if (before.userId !== ctx.userId && ctx.role !== "owner" && ctx.role !== "admin") throw new HTTPException(403, { message: "só quem escreveu ou um administrador pode apagar" });
    await ctx.db.batch([ctx.db.delete(taskComments).where(eq(taskComments.id, before.id)), auditInsert(ctx, "task_comment", task.id, "delete", { commentId: before.id, body: before.body }, null)]);
    return c.body(null, 204);
  });

  // ---------- Histórico ----------

  /** Tudo o que aconteceu com a tarefa, do mais novo para o mais antigo. */
  api.get("/tasks/:id/history", async (c) => {
    const ctx = c.get("ctx");
    const task = await getTask(ctx, c.req.param("id"));
    const rows = await ctx.db
      .select({ a: auditLog, name: users.name, email: users.email })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(and(eq(auditLog.workspaceId, ctx.workspaceId), eq(auditLog.entityId, task.id), inArray(auditLog.entity, ["task", "task_item", "task_comment"])))
      // created_at tem precisão de segundo; o rowid desempata na ordem de gravação.
      .orderBy(desc(auditLog.createdAt), sql`"audit_log".rowid DESC`)
      .limit(HISTORY_LIMIT);
    return c.json(
      rows.map(({ a, name, email }) =>
        serialize({ id: a.id, entity: a.entity, action: a.action, userId: a.userId, userName: name || email || null, before: a.before, after: a.after, createdAt: a.createdAt }),
      ),
    );
  });
}
