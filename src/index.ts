import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { requireMember, type AppEnv } from "./api/context";
import { ValidationError } from "./api/helpers";
import { api } from "./api/routes";
import { AuthError, finishLogin, startLogin, type LoginTransaction } from "./auth/google";
import { AccessDenied, createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS, upsertUser } from "./auth/session";
import { getDb } from "./db/client";
import { users } from "./db/schema";

const TX_COOKIE = "oauth_tx";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message, issues: err.issues }, 400);
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "erro interno" }, 500);
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
  if (!tx || !code || c.req.query("state") !== tx.state) return c.text("Login expirado. Tente de novo.", 400);

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
    if (err instanceof AccessDenied) return c.text("Esta conta não tem acesso à Central de Organização.", 403);
    if (err instanceof AuthError) return c.text("Não foi possível confirmar o login com o Google.", 400);
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

app.route("/api", api);

export default app;
