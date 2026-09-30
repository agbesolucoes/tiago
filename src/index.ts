import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { requireMember, requireRole, type AppEnv } from "./api/context";
import { attachmentsApi } from "./api/attachments";
import { integrations } from "./api/integrations";
import { ops } from "./api/ops";
import { ValidationError } from "./api/helpers";
import { api } from "./api/routes";
import { AuthError, CALENDAR_REDIRECT_PATH, CALENDAR_SCOPES, DRIVE_SCOPE, exchangeCode, finishLogin, startAuthorization, startLogin, type LoginTransaction } from "./auth/google";
import { AccessDenied, allowedEmails, createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS, upsertUser } from "./auth/session";
import { getDb } from "./db/client";
import { auditLog, integrationAccounts, users } from "./db/schema";
import type { Env } from "./env";
import { refreshCalendarList, syncAll, syncWorkspace } from "./integrations/calendar-sync";
import { pruneReminders, sendReminders } from "./integrations/reminders";
import { handleUpdate, sendDailySummaries, telegramEnabled } from "./integrations/telegram-bot";
import type { TgUpdate } from "./integrations/telegram-client";
import { newId } from "./lib/crypto";
import { log, recordError } from "./lib/log";
import { encryptSecret } from "./lib/secret";
import { backupConfigured, pruneOps, runBackup } from "./ops/backup";

const TX_COOKIE = "oauth_tx";

const app = new Hono<AppEnv>();

// Cada requisição ganha um id (volta no cabeçalho x-request-id e aparece nos logs e erros).
app.use("*", async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  const started = Date.now();
  await next();
  c.header("x-request-id", requestId);
  const status = c.res.status;
  log(status >= 500 ? "error" : "info", "request", { requestId, method: c.req.method, path: c.req.path, status, ms: Date.now() - started });
});

app.onError(async (err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message, issues: err.issues }, 400);
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  const requestId = c.get("requestId");
  await recordError(getDb(c.env.DB), `http ${c.req.method} ${c.req.routePath}`, err, requestId);
  return c.json({ error: "erro interno", requestId }, 500);
});

/** Verificação pública para monitor externo (UptimeRobot etc.): sem dados, só se o Worker e o banco respondem. */
app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true });
  } catch (e) {
    await recordError(getDb(c.env.DB), "health", e, c.get("requestId"));
    return c.json({ ok: false }, 503);
  }
});

// ---------- Login Google ----------

app.get("/auth/login", async (c) => {
  const { url, tx } = await startLogin(c.env.GOOGLE_CLIENT_ID, c.env.APP_URL);
  setCookie(c, TX_COOKIE, btoa(JSON.stringify(tx)), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  return c.redirect(url);
});

app.get("/auth/callback", async (c) => {
  const raw = getCookie(c, TX_COOKIE);
  deleteCookie(c, TX_COOKIE, { path: "/auth" });
  const code = c.req.query("code");
  let tx: LoginTransaction | null = null;
  try {
    tx = raw ? (JSON.parse(atob(raw)) as LoginTransaction) : null;
  } catch {}
  if (!tx || !code || c.req.query("state") !== tx.state) return c.redirect("/?erro=expirado");

  try {
    const identity = await finishLogin({
      code,
      tx,
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      appUrl: c.env.APP_URL,
    });
    const db = getDb(c.env.DB);
    const user = await upsertUser(db, identity, c.env.ALLOWED_EMAILS);
    const token = await createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.redirect("/");
  } catch (err) {
    if (err instanceof AccessDenied) return c.redirect("/?erro=acesso");
    if (err instanceof AuthError) return c.redirect("/?erro=login");
    throw err;
  }
});

// Login sem Google para desenvolvimento local. Exige DEV_LOGIN=true e acesso por localhost.
app.get("/auth/dev-login", async (c) => {
  const host = new URL(c.req.url).hostname;
  if (c.env.DEV_LOGIN !== "true" || !["localhost", "127.0.0.1"].includes(host)) return c.notFound();
  const email = (c.req.query("email") ?? allowedEmails(c.env.ALLOWED_EMAILS)[0] ?? "").toLowerCase();
  const db = getDb(c.env.DB);
  try {
    const user = await upsertUser(db, { sub: `dev:${email}`, email, name: email.split("@")[0] }, c.env.ALLOWED_EMAILS);
    const token = await createSession(db, user.id);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
    return c.redirect("/");
  } catch (err) {
    if (err instanceof AccessDenied) return c.text("E-mail fora de ALLOWED_EMAILS.", 403);
    throw err;
  }
});

app.post("/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSession(getDb(c.env.DB), token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});

// ---------- API ----------

app.get("/api/me", requireMember, async (c) => {
  const ctx = c.get("ctx");
  const user = await ctx.db.query.users.findFirst({ where: eq(users.id, ctx.userId) });
  return c.json({
    user: { id: user!.id, email: user!.email, name: user!.name },
    workspace: { id: ctx.workspaceId, role: ctx.role, timezone: ctx.timezone },
  });
});

app.route("/api/integrations", integrations);
app.route("/api/ops", ops);
app.route("/api/attachments", attachmentsApi);
app.route("/api", api);

// ---------- Conexão com o Google Agenda ----------

const CAL_TX_COOKIE = "google_tx";

app.get("/integrations/google/connect", requireMember, async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const user = await ctx.db.query.users.findFirst({ where: eq(users.id, ctx.userId) });
  const { url, tx } = await startAuthorization({
    clientId: c.env.GOOGLE_CLIENT_ID,
    appUrl: c.env.APP_URL,
    redirectPath: CALENDAR_REDIRECT_PATH,
    scopes: [...CALENDAR_SCOPES, DRIVE_SCOPE],
    offline: true,
    loginHint: user?.email,
  });
  setCookie(c, CAL_TX_COOKIE, btoa(JSON.stringify(tx)), { httpOnly: true, secure: true, sameSite: "Lax", path: "/integrations/google", maxAge: 600 });
  return c.redirect(url);
});

app.get("/integrations/google/callback", requireMember, async (c) => {
  const ctx = c.get("ctx");
  requireRole(ctx, "owner", "admin");
  const raw = getCookie(c, CAL_TX_COOKIE);
  deleteCookie(c, CAL_TX_COOKIE, { path: "/integrations/google" });
  const back = (q: string) => c.redirect(`/configuracoes?google=${q}`);
  if (c.req.query("error")) return back("cancelado");
  let tx: LoginTransaction | null = null;
  try {
    tx = raw ? (JSON.parse(atob(raw)) as LoginTransaction) : null;
  } catch {}
  const code = c.req.query("code");
  if (!tx || !code || c.req.query("state") !== tx.state) return back("expirado");

  let result;
  try {
    result = await exchangeCode({
      code,
      tx,
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      appUrl: c.env.APP_URL,
      redirectPath: CALENDAR_REDIRECT_PATH,
    });
  } catch {
    return back("erro");
  }
  // A pessoa pode desmarcar permissões na tela do Google: sem as duas, não há como sincronizar.
  if (!CALENDAR_SCOPES.every((s) => result.tokens.scopes.includes(s))) return back("escopos");
  if (!result.tokens.refreshToken) return back("erro");

  const key = c.env.TOKEN_ENCRYPTION_KEY;
  const values = {
    userId: ctx.userId,
    externalSub: result.identity.sub,
    email: result.identity.email,
    scopes: result.tokens.scopes.join(" "),
    refreshTokenEnc: await encryptSecret(result.tokens.refreshToken, key),
    accessTokenEnc: await encryptSecret(result.tokens.accessToken, key),
    accessTokenExpiresAt: result.tokens.expiresAt,
    status: "active" as const,
    lastError: null,
    updatedAt: Date.now(),
  };
  const existing = await ctx.db.query.integrationAccounts.findFirst({
    where: and(eq(integrationAccounts.workspaceId, ctx.workspaceId), eq(integrationAccounts.provider, "google")),
  });
  // Outra conta Google no lugar da anterior: as agendas antigas não valem mais.
  if (existing && existing.externalSub !== result.identity.sub) {
    await ctx.db.delete(integrationAccounts).where(eq(integrationAccounts.id, existing.id));
  }
  const keep = existing && existing.externalSub === result.identity.sub;
  const id = keep ? existing.id : newId();
  if (keep) await ctx.db.update(integrationAccounts).set(values).where(eq(integrationAccounts.id, id));
  else await ctx.db.insert(integrationAccounts).values({ id, workspaceId: ctx.workspaceId, provider: "google", ...values });
  await ctx.db.insert(auditLog).values({ id: newId(), workspaceId: ctx.workspaceId, userId: ctx.userId, entity: "integration", entityId: id, action: keep ? "update" : "create", after: { email: values.email, scopes: values.scopes } });

  const account = (await ctx.db.query.integrationAccounts.findFirst({ where: eq(integrationAccounts.id, id) }))!;
  const deps = { db: ctx.db, env: c.env };
  try {
    await refreshCalendarList(deps, account);
    c.executionCtx.waitUntil(syncWorkspace(deps, ctx.workspaceId).catch((e) => console.error("sync inicial", e)));
  } catch (e) {
    console.error("agendas", e);
  }
  return back("conectado");
});

// ---------- Telegram ----------

async function sameSecret(a: string, b: string) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

app.post("/integrations/telegram/webhook", async (c) => {
  if (!telegramEnabled(c.env)) return c.body(null, 404);
  // O Telegram manda o segredo registrado no setWebhook; sem ele, a requisição não veio do Telegram.
  const secret = c.req.header("x-telegram-bot-api-secret-token") ?? "";
  if (!(await sameSecret(secret, c.env.TELEGRAM_WEBHOOK_SECRET!))) return c.body(null, 401);
  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  if (!update || typeof update.update_id !== "number") return c.json({ ok: true });
  await handleUpdate({ db: getDb(c.env.DB), env: c.env }, update);
  return c.json({ ok: true });
});

const DAILY_SUMMARY_CRON = "0 11 * * *";
const BACKUP_CRON = "0 6 * * *";
/** Os mesmos de `triggers.crons` no wrangler.jsonc; o servidor Node usa esta lista. */
export const CRONS = ["*/5 * * * *", BACKUP_CRON, DAILY_SUMMARY_CRON];

export default {
  fetch: app.fetch,
  // Crons: a cada 5 minutos envia a fila e traz as mudanças do Google; às 3h de São Paulo (6h UTC) faz o backup;
  // às 8h (11h UTC) manda o resumo do dia.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const db = getDb(env.DB);
    const run = async (name: string, job: () => Promise<unknown>) => {
      try {
        await job();
      } catch (e) {
        await recordError(db, `cron ${name}`, e);
      }
    };
    if (controller.cron === DAILY_SUMMARY_CRON) ctx.waitUntil(run("resumo", () => sendDailySummaries({ db, env })));
    else if (controller.cron === BACKUP_CRON)
      ctx.waitUntil(
        run("backup", async () => {
          if (backupConfigured(env)) await runBackup({ db, env }, "cron");
          else log("warn", "backup.skipped", { reason: "não configurado" });
          await pruneOps(db);
          await pruneReminders(db);
        }),
      );
    else {
      ctx.waitUntil(run("sync", () => syncAll({ db, env })));
      ctx.waitUntil(run("lembretes", () => sendReminders({ db, env })));
    }
  },
} satisfies ExportedHandler<Env>;
