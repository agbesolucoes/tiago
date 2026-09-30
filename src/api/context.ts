import { and, asc, eq } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { findSessionUser, SESSION_COOKIE } from "../auth/session";
import { getDb, type Db } from "../db/client";
import { memberships, workspaces, type Role } from "../db/schema";
import type { Env } from "../env";

export interface RequestContext {
  db: Db;
  userId: string;
  workspaceId: string;
  role: Role;
  timezone: string;
}

export type AppEnv = { Bindings: Env; Variables: { ctx: RequestContext } };

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Exige sessão válida e resolve o workspace (cabeçalho X-Workspace-Id ou o primeiro do usuário). */
export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  if (MUTATING.has(c.req.method)) {
    // Proteção CSRF: Origin, quando presente, precisa ser o do app; corpo só em JSON.
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.env.APP_URL).origin) throw new HTTPException(403, { message: "origem inválida" });
    const type = c.req.header("content-type") ?? "";
    // Upload envia o arquivo cru; em troca exige um cabeçalho próprio, que outro site não consegue mandar.
    const upload = c.req.path.endsWith("/attachments/upload") && c.req.header("x-central-upload") === "1";
    if (c.req.method !== "DELETE" && !upload && !type.startsWith("application/json"))
      throw new HTTPException(415, { message: "use application/json" });
  }

  const db = getDb(c.env.DB);
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await findSessionUser(db, token) : null;
  if (!user) throw new HTTPException(401, { message: "não autenticado" });

  const requested = c.req.header("x-workspace-id");
  const row = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role, timezone: workspaces.timezone })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      requested
        ? and(eq(memberships.userId, user.id), eq(memberships.workspaceId, requested))
        : eq(memberships.userId, user.id),
    )
    .orderBy(asc(memberships.createdAt))
    .get();
  // 404 e não 403: não revela se o workspace existe.
  if (!row) throw new HTTPException(requested ? 404 : 403, { message: "workspace não encontrado" });

  c.set("ctx", { db, userId: user.id, ...row });
  await next();
});

export function requireRole(ctx: RequestContext, ...allowed: Role[]) {
  if (!allowed.includes(ctx.role)) throw new HTTPException(403, { message: "permissão insuficiente" });
}
