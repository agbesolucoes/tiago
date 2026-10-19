import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { integrationAccounts, users } from "../src/db/schema";
import type { Env } from "../src/env";
import { googleFetch } from "../src/integrations/google-client";
import worker from "../src/index";
import { newId } from "../src/lib/crypto";
import { encryptSecret } from "../src/lib/secret";
import { SqliteD1 } from "../src/node/d1-sqlite";
import { applyMigrations } from "../src/node/migrate";
import { FakeGoogle } from "../test/fake-google";

// Envio de anexo ao Drive no Node de verdade: o corpo sai em streaming pelo fetch do Node (undici)
// até um servidor HTTP local que faz o papel do Google.
let dir: string;
let d1: SqliteD1;
let env: Env;
let cookie = "";
let google: Server;
let googleUrl = "";
const g = new FakeGoogle();
const received: { url: string; contentLength: string | undefined; bytes: number }[] = [];
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

beforeAll(async () => {
  google = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const original = `https://www.googleapis.com${req.url}`;
      received.push({ url: original, contentLength: req.headers["content-length"], bytes: body.length });
      const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
      const out = await g.fetch(original, { method: req.method, headers, body: body.length ? body : undefined });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => google.listen(0, "127.0.0.1", r));
  googleUrl = `http://127.0.0.1:${(google.address() as { port: number }).port}`;
  // Token e Drive passam pelo fetch real do Node; só o endereço muda.
  googleFetch.impl = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return g.fetch(input, init);
    return fetch(`${googleUrl}${url.pathname}${url.search}`, init);
  };

  dir = mkdtempSync(join(tmpdir(), "central-drive-"));
  d1 = new SqliteD1(join(dir, "central.db"));
  applyMigrations(d1, "migrations");
  env = {
    DB: d1.asD1(),
    APP_URL: "http://localhost",
    ALLOWED_EMAILS: "dono@exemplo.com",
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    DEV_LOGIN: "true",
    PUSH_ON_WRITE: "false",
  } as Env;
  const login = await worker.fetch(new Request("http://localhost/auth/dev-login"), env, ctx);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  const db = getDb(env.DB);
  const user = (await db.select().from(users))[0];
  const ws = await db.query.memberships.findFirst();
  await db.insert(integrationAccounts).values({
    id: newId(),
    workspaceId: ws!.workspaceId,
    userId: user.id,
    provider: "google",
    externalSub: "g-1",
    email: "dono@gmail.com",
    scopes: "openid email https://www.googleapis.com/auth/drive.file",
    refreshTokenEnc: await encryptSecret("rt", env.TOKEN_ENCRYPTION_KEY),
  });
});
afterAll(() => {
  google.close();
  d1.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("anexos no Drive pelo servidor Node", () => {
  it("envia o arquivo em streaming, com o tamanho certo, e grava o anexo", async () => {
    const size = 3 * 1024 * 1024 + 7;
    const data = new Uint8Array(size).map((_, i) => i % 251);
    // Corpo em streaming, como chega do navegador pelo @hono/node-server.
    const stream = new Blob([data]).stream();
    const req = new Request("http://localhost/api/attachments/upload?parentKind=general&name=planta.pdf", {
      method: "POST",
      headers: { cookie, "content-type": "application/pdf", "content-length": String(size), "x-central-upload": "1" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const res = await worker.fetch(req, env, ctx);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ name: "planta.pdf", mimeType: "application/pdf", origin: "uploaded" });
    const put = received.find((r) => r.url.includes("upload_id="))!;
    expect(put).toMatchObject({ contentLength: String(size), bytes: size });
  });
});
