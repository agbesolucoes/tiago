import { serve } from "@hono/node-server";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Env } from "../env";
import worker, { CRONS } from "../index";
import { SqliteD1 } from "./d1-sqlite";
import { FsBucket } from "./fs-bucket";
import { applyMigrations } from "./migrate";
import { startScheduler } from "./scheduler";

// Servidor Node (Hostinger e afins): o mesmo app do Worker, com SQLite no lugar do D1,
// uma pasta no lugar do R2 e um agendador no lugar dos Cron Triggers.

if (existsSync(".env")) process.loadEnvFile(".env");
const e = process.env;
const cwd = process.cwd();
// Banco e backups ficam FORA da pasta do app por padrão: na Hostinger a pasta do build é
// recriada a cada publicação, e um banco lá dentro seria apagado.
const DATA_DIR = resolve(cwd, e.DATA_DIR ?? join(homedir(), "central-data"));
const DATABASE_PATH = resolve(cwd, e.DATABASE_PATH ?? join(DATA_DIR, "central.db"));
const BACKUP_DIR = resolve(cwd, e.BACKUP_DIR ?? join(DATA_DIR, "backups"));
// Telas e migrações são achadas a partir do próprio arquivo (dist/server/index.mjs), seja qual for a pasta de trabalho.
const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(cwd, e.STATIC_DIR ?? join(here, "../client"));
const MIGRATIONS_DIR = resolve(cwd, e.MIGRATIONS_DIR ?? join(here, "../../migrations"));
const PORT = Number(e.PORT ?? 3000);

for (const name of ["APP_URL", "ALLOWED_EMAILS", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
  if (!e[name]) console.warn(JSON.stringify({ level: "warn", event: "config.missing", name }));
}

mkdirSync(dirname(DATABASE_PATH), { recursive: true });
const d1 = new SqliteD1(DATABASE_PATH);
const applied = applyMigrations(d1, MIGRATIONS_DIR);
if (applied.length) console.log(JSON.stringify({ level: "info", event: "migrations.applied", applied }));

const env: Env = {
  DB: d1.asD1(),
  APP_URL: e.APP_URL ?? `http://localhost:${PORT}`,
  ALLOWED_EMAILS: e.ALLOWED_EMAILS ?? "",
  GOOGLE_CLIENT_ID: e.GOOGLE_CLIENT_ID ?? "",
  GOOGLE_CLIENT_SECRET: e.GOOGLE_CLIENT_SECRET ?? "",
  TOKEN_ENCRYPTION_KEY: e.TOKEN_ENCRYPTION_KEY ?? "",
  GOOGLE_PICKER_API_KEY: e.GOOGLE_PICKER_API_KEY,
  GOOGLE_PROJECT_NUMBER: e.GOOGLE_PROJECT_NUMBER,
  TELEGRAM_BOT_TOKEN: e.TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: e.TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_BOT_USERNAME: e.TELEGRAM_BOT_USERNAME,
  // A pasta de backup só existe com a chave: sem chave o backup fica desligado, como na Cloudflare.
  BACKUPS: e.BACKUP_ENCRYPTION_KEY ? new FsBucket(BACKUP_DIR).asR2() : undefined,
  BACKUP_ENCRYPTION_KEY: e.BACKUP_ENCRYPTION_KEY,
  // Num servidor próprio o disco pode se perder junto com o banco: por padrão, cada backup vai também para o Drive.
  BACKUP_TO_DRIVE: e.BACKUP_TO_DRIVE ?? "true",
  DEV_LOGIN: e.DEV_LOGIN,
  PUSH_ON_WRITE: e.PUSH_ON_WRITE,
};

/** Substitui o ExecutionContext: o trabalho em segundo plano continua depois da resposta. */
const ctx = {
  waitUntil(p: Promise<unknown>) {
    p.catch((err) => console.error(JSON.stringify({ level: "error", event: "background.failed", error: String(err) })));
  },
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

// ---------- Arquivos das telas ----------

const WORKER_PATHS = ["/api/", "/auth/", "/integrations/"];
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function file(path: string) {
  const p = resolve(STATIC_DIR, "." + path);
  if (p !== STATIC_DIR && !p.startsWith(STATIC_DIR + sep)) return null;
  try {
    if (!(await stat(p)).isFile()) return null;
    return { body: await readFile(p), type: TYPES[extname(p)] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

async function serveStatic(req: Request) {
  const { pathname } = new URL(req.url);
  const found = pathname !== "/" ? await file(decodeURIComponent(pathname)) : null;
  if (found) {
    // Arquivos em /assets têm hash no nome: podem ficar em cache para sempre.
    const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(req.method === "HEAD" ? null : found.body, { headers: { "content-type": found.type, "cache-control": cache } });
  }
  // Rotas das telas (ex.: /tarefas) abrem o index.html, como o single-page-application da Cloudflare.
  const index = await file("/index.html");
  if (!index) return new Response("Telas não encontradas: rode `npm run build` antes de iniciar.", { status: 500 });
  return new Response(req.method === "HEAD" ? null : index.body, { headers: { "content-type": index.type, "cache-control": "no-cache" } });
}

async function handle(req: Request) {
  const { pathname } = new URL(req.url);
  if (WORKER_PATHS.some((p) => pathname.startsWith(p))) return worker.fetch(req, env, ctx);
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Método não permitido", { status: 405 });
  return serveStatic(req);
}

const server = serve({ fetch: handle, port: PORT }, (info) => {
  console.log(JSON.stringify({ level: "info", event: "server.started", port: info.port, database: DATABASE_PATH, backups: BACKUP_DIR }));
});

const stopScheduler = startScheduler(CRONS, async (cron, at) => {
  // Espera o trabalho do cron terminar, para o agendador não disparar o mesmo cron por cima.
  const pending: Promise<unknown>[] = [];
  const cronCtx = { ...ctx, waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
  await worker.scheduled({ cron, scheduledTime: at.getTime(), noRetry() {} } as ScheduledController, env, cronCtx);
  await Promise.allSettled(pending);
});

// Desligamento limpo: para o agendador, fecha as conexões e o banco.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopScheduler();
    server.close(() => {
      d1.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
