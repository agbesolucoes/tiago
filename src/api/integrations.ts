import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { calendars, events, integrationAccounts, syncJobs } from "../db/schema";
import { GoogleError, revokeToken } from "../integrations/google-client";
import { jobCounts, refreshCalendarList, syncWorkspace } from "../integrations/calendar-sync";
import { decryptSecret } from "../lib/secret";
import { requireMember, requireRole, type AppEnv, type RequestContext } from "./context";
import { auditInsert, parseBody, ValidationError } from "./helpers";

export const integrations = new Hono<AppEnv>();
integrations.use("*", requireMember);

const toIso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

async function getAccount(ctx: RequestContext) {
  return ctx.db.query.integrationAccounts.findFirst({
    where: and(eq(integrationAccounts.workspaceId, ctx.workspaceId), eq(integrationAccounts.provider, "google")),
  });
}

async function status(ctx: RequestContext) {
  const account = await getAccount(ctx);
  if (!account) return { connected: false as const };
  const cals = await ctx.db
    .select({
      id: calendars.googleCalendarId,
      summary: calendars.summary,
      primary: calendars.primary,
      writable: calendars.writable,
      selected: calendars.selected,
    })
    .from(calendars)
    .where(eq(calendars.accountId, account.id))
    .orderBy(calendars.summary);
  const counts = await jobCounts(ctx.db, ctx.workspaceId);
  return {
    connected: true as const,
    email: account.email,
    status: account.status,
    lastError: account.lastError,
    lastSyncAt: toIso(account.lastSyncAt),
    defaultCalendarId: account.defaultCalendarId,
    calendars: cals.sort((a, b) => Number(b.primary) - Number(a.primary)),
    pendingJobs: counts.pending ?? 0,
    failedJobs: counts.failed ?? 0,
  };
}

integrations.get("/google", async (c) => c.json(await status(c.get("ctx"))));

const settings = z.strictObject({
  defaultCalendarId: z.string().min(1).nullable().optional(),
  calendars: z.array(z.strictObject({ id: z.string().min(1), selected: z.boolean() })).max(100).optional(),
});

integrations.patch("/google", async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const account = await getAccount(ctx);
  if (!account) return c.json({ error: "Google não conectado" }, 404);
  const body = await parseBody(c, settings);
  const known = await ctx.db.select().from(calendars).where(eq(calendars.accountId, account.id));
  const byId = new Map(known.map((k) => [k.googleCalendarId, k]));

  if (body.defaultCalendarId) {
    const cal = byId.get(body.defaultCalendarId);
    if (!cal) throw new ValidationError([{ path: "defaultCalendarId", message: "agenda desconhecida" }]);
    if (!cal.writable) throw new ValidationError([{ path: "defaultCalendarId", message: "sem permissão de escrita nessa agenda" }]);
  }
  for (const item of body.calendars ?? []) {
    if (!byId.has(item.id)) throw new ValidationError([{ path: "calendars", message: "agenda desconhecida" }]);
  }

  const stmts: any[] = [];
  if (body.defaultCalendarId !== undefined) {
    stmts.push(ctx.db.update(integrationAccounts).set({ defaultCalendarId: body.defaultCalendarId, updatedAt: Date.now() }).where(eq(integrationAccounts.id, account.id)));
  }
  for (const item of body.calendars ?? []) {
    const cal = byId.get(item.id)!;
    // Ao tirar uma agenda da sincronização, o token é descartado; ao voltar, faz sync completo.
    stmts.push(ctx.db.update(calendars).set({ selected: item.selected, syncToken: item.selected ? cal.syncToken : null, updatedAt: Date.now() }).where(eq(calendars.id, cal.id)));
  }
  stmts.push(auditInsert(ctx, "integration", account.id, "update", { defaultCalendarId: account.defaultCalendarId }, body));
  await ctx.db.batch(stmts as [any, ...any[]]);
  return c.json(await status(ctx));
});

integrations.post("/google/sync", async (c) => {
  const ctx = c.get("ctx");
  const account = await getAccount(ctx);
  if (!account) return c.json({ error: "Google não conectado" }, 404);
  const deps = { db: ctx.db, env: c.env };
  try {
    if (account.status === "active") await refreshCalendarList(deps, account);
    const result = await syncWorkspace(deps, ctx.workspaceId);
    return c.json({ ...(await status(ctx)), result });
  } catch (e) {
    const message = e instanceof GoogleError ? e.message : "Falha ao sincronizar";
    return c.json({ ...(await status(ctx)), error: message }, 502);
  }
});

/** Desconectar: revoga o token no Google, apaga a conta e desativa a fila. Os compromissos ficam. */
integrations.delete("/google", async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const account = await getAccount(ctx);
  if (!account) return c.body(null, 204);
  try {
    await revokeToken(await decryptSecret(account.refreshTokenEnc, c.env.TOKEN_ENCRYPTION_KEY));
  } catch {
    // Mesmo sem conseguir revogar, a conta local é apagada.
  }
  const pending = await ctx.db
    .select({ eventId: syncJobs.eventId })
    .from(syncJobs)
    .where(and(eq(syncJobs.workspaceId, ctx.workspaceId), eq(syncJobs.status, "pending")));
  await ctx.db.batch([
    ctx.db.delete(syncJobs).where(and(eq(syncJobs.workspaceId, ctx.workspaceId), eq(syncJobs.status, "pending"))),
    ctx.db.delete(integrationAccounts).where(eq(integrationAccounts.id, account.id)),
    ...(pending.length
      ? [ctx.db.update(events).set({ syncStatus: "local" }).where(and(eq(events.workspaceId, ctx.workspaceId), inArray(events.id, pending.map((p) => p.eventId))))]
      : []),
    auditInsert(ctx, "integration", account.id, "delete", { email: account.email }, null),
  ]);
  return c.body(null, 204);
});
