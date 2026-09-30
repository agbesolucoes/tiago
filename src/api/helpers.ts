import { and, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { auditLog, memberships } from "../db/schema";
import { newId } from "../lib/crypto";
import { parseDateTime, toIso } from "../lib/time";
import type { AppEnv, RequestContext } from "./context";

export class ValidationError extends HTTPException {
  constructor(public issues: { path: string; message: string }[]) {
    super(400, { message: "dados inválidos" });
  }
}

export async function parseBody<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError([{ path: "", message: "JSON inválido" }]);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return result.data;
}

export function toUtc(ctx: RequestContext, value: string | null | undefined, field: string): number | null | undefined {
  if (value === undefined || value === null) return value;
  const ms = parseDateTime(value, ctx.timezone);
  if (ms === null) throw new ValidationError([{ path: field, message: "data inválida" }]);
  return ms;
}

type WsTable = SQLiteTable & { id: any; workspaceId: any };

/** Garante que uma referência (projeto, evento...) pertence ao mesmo workspace. */
export async function ensureRef(ctx: RequestContext, table: WsTable, id: string | null | undefined, field: string) {
  if (!id) return;
  const row = await ctx.db
    .select({ id: table.id })
    .from(table as any)
    .where(and(eq(table.id, id), eq(table.workspaceId, ctx.workspaceId)))
    .get();
  if (!row) throw new ValidationError([{ path: field, message: "não encontrado neste workspace" }]);
}

export async function ensureMember(ctx: RequestContext, userId: string | null | undefined, field: string) {
  if (!userId) return;
  const row = await ctx.db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, ctx.workspaceId), eq(memberships.userId, userId)),
  });
  if (!row) throw new ValidationError([{ path: field, message: "não é membro deste workspace" }]);
}

export function auditInsert(
  ctx: RequestContext,
  entity: string,
  entityId: string,
  action: "create" | "update" | "delete" | "convert",
  before: unknown,
  after: unknown,
) {
  return ctx.db.insert(auditLog).values({
    id: newId(),
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    entity,
    entityId,
    action,
    before: before ?? null,
    after: after ?? null,
  });
}

const DATE_KEYS = new Set(["createdAt", "updatedAt", "dueAt", "startAt", "endAt"]);

/** Converte datas numéricas para ISO UTC na resposta. */
export function serialize<T extends Record<string, unknown>>(row: T) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = DATE_KEYS.has(k) ? toIso(v as number | null) : v;
  return out;
}

export function notFound(): never {
  throw new HTTPException(404, { message: "não encontrado" });
}

/** Escapa curingas do LIKE. */
export function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
