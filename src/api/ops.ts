import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { allowedEmails } from "../auth/session";
import { appErrors, backupRuns, integrationAccounts, syncJobs, telegramLinks, users } from "../db/schema";
import { telegramEnabled } from "../integrations/telegram-bot";
import { backupConfigured, recentRuns, runBackup } from "../ops/backup";
import { requireMember, type AppEnv, type RequestContext } from "./context";

/** Operação do servidor (backups de todo o banco, erros): só o dono da instalação, o primeiro de ALLOWED_EMAILS. */
export const ops = new Hono<AppEnv>();
ops.use("*", requireMember);
ops.use("*", async (c, next) => {
  await requireInstanceAdmin(c.get("ctx"), c.env.ALLOWED_EMAILS);
  await next();
});

async function requireInstanceAdmin(ctx: RequestContext, allowed: string) {
  const user = await ctx.db.query.users.findFirst({ where: eq(users.id, ctx.userId) });
  if (ctx.role !== "owner" || !user || user.email.toLowerCase() !== allowedEmails(allowed)[0]) {
    throw new HTTPException(403, { message: "só o dono da instalação" });
  }
}

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
const runView = (r: typeof backupRuns.$inferSelect) => ({
  id: r.id,
  trigger: r.trigger,
  status: r.status,
  size: r.size,
  tables: r.tables,
  rows: r.tables ? Object.values(r.tables).reduce((a, b) => a + b, 0) : null,
  error: r.error,
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
  downloadable: r.status === "ok" && !!r.objectKey,
});

ops.get("/status", async (c) => {
  const db = c.get("ctx").db;
  const since = Date.now() - 86_400_000;
  const [runs, lastOk, jobs, accounts, links, errors24h, recentErrors] = await Promise.all([
    recentRuns(db, 5),
    db.query.backupRuns.findFirst({ where: eq(backupRuns.status, "ok"), orderBy: desc(backupRuns.startedAt) }),
    db.select({ status: syncJobs.status, n: count() }).from(syncJobs).where(sql`${syncJobs.status} in ('pending','failed')`).groupBy(syncJobs.status),
    db.select({ email: integrationAccounts.email, status: integrationAccounts.status, lastSyncAt: integrationAccounts.lastSyncAt, lastError: integrationAccounts.lastError }).from(integrationAccounts),
    db.select({ n: count() }).from(telegramLinks),
    db.select({ n: count() }).from(appErrors).where(gte(appErrors.createdAt, since)),
    db.select().from(appErrors).orderBy(desc(appErrors.createdAt)).limit(5),
  ]);
  const jobCount = Object.fromEntries(jobs.map((j) => [j.status, j.n]));
  return c.json({
    backups: { configured: backupConfigured(c.env), lastOkAt: iso(lastOk?.startedAt), recent: runs.map(runView) },
    google: { accounts: accounts.map((a) => ({ ...a, lastSyncAt: iso(a.lastSyncAt) })), pendingJobs: jobCount.pending ?? 0, failedJobs: jobCount.failed ?? 0 },
    telegram: { enabled: telegramEnabled(c.env), links: links[0].n },
    errors: {
      last24h: errors24h[0].n,
      recent: recentErrors.map((e) => ({ id: e.id, source: e.source, message: e.message, requestId: e.requestId, at: iso(e.createdAt) })),
    },
  });
});

ops.post("/backup", async (c) => {
  const ctx = c.get("ctx");
  if (!backupConfigured(c.env)) return c.json({ error: "o backup ainda não foi configurado no servidor" }, 409);
  const run = await runBackup({ db: ctx.db, env: c.env }, "manual");
  return c.json(runView(run), run.status === "ok" ? 201 : 500);
});

/** Baixa o arquivo cifrado, para guardar uma cópia fora da Cloudflare. */
ops.get("/backups/:id/download", async (c) => {
  const ctx = c.get("ctx");
  const run = await ctx.db.query.backupRuns.findFirst({ where: and(eq(backupRuns.id, c.req.param("id")), eq(backupRuns.status, "ok")) });
  const object = run?.objectKey && c.env.BACKUPS ? await c.env.BACKUPS.get(run.objectKey) : null;
  if (!object) return c.json({ error: "arquivo não encontrado; ele pode ter saído pela retenção de 30 dias" }, 404);
  const name = run!.objectKey!.split("/").pop()!;
  return new Response(object.body, {
    headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="central-${name}"`, "cache-control": "no-store" },
  });
});
