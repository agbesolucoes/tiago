import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { tasks } from "../src/db/schema";
import type { Env } from "../src/env";
import worker from "../src/index";
import { createSnapshot, runBackup } from "../src/ops/backup";
import { snapshotToStatements, unpackSnapshot } from "../src/ops/snapshot";
import { SqliteD1 } from "../src/node/d1-sqlite";
import { FsBucket } from "../src/node/fs-bucket";
import { applyMigrations } from "../src/node/migrate";
import { cronMatches } from "../src/node/scheduler";

const KEY = "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=";
let dir: string;
let d1: SqliteD1;
let env: Env;
let cookie = "";
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function call(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      redirect: "manual",
      headers: { cookie, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  return res;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "central-node-"));
  d1 = new SqliteD1(join(dir, "central.db"));
  env = {
    DB: d1.asD1(),
    APP_URL: "http://localhost",
    ALLOWED_EMAILS: "dono@exemplo.com",
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    BACKUPS: new FsBucket(join(dir, "backups")).asR2(),
    BACKUP_ENCRYPTION_KEY: KEY,
    DEV_LOGIN: "true",
    PUSH_ON_WRITE: "false",
  };
});
afterAll(() => {
  d1.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("servidor Node com SQLite", () => {
  it("aplica as migrações uma vez só", () => {
    const first = applyMigrations(d1, "migrations");
    expect(first[0]).toBe("0000_init.sql");
    expect(applyMigrations(d1, "migrations")).toEqual([]);
  });

  it("roda o app inteiro: login, tarefa com checklist, série de compromissos", async () => {
    expect((await call("GET", "/api/health")).status).toBe(200);
    const login = await call("GET", "/auth/dev-login");
    expect(login.status).toBe(302);
    cookie = login.headers.get("set-cookie")!.split(";")[0];

    const task = (await (await call("POST", "/api/tasks", { title: "Pintar a sala", dueAt: "2026-10-05" })).json()) as any;
    expect(task.dueAt).toBe("2026-10-05T03:00:00.000Z");
    const item = (await (await call("POST", `/api/tasks/${task.id}/checklist`, { text: "Comprar tinta" })).json()) as any;
    expect(((await (await call("PATCH", `/api/tasks/${task.id}/checklist/${item.id}`, { done: true })).json()) as any).done).toBe(true);
    const list = (await (await call("GET", "/api/tasks")).json()) as any;
    expect(list[0]).toMatchObject({ checklistTotal: 1, checklistDone: 1 });

    const series = await call("POST", "/api/events", { title: "Reunião", startAt: "2026-10-05T10:00", endAt: "2026-10-05T11:00", repeat: { freq: "weekly", byDay: ["MO", "WE"], count: 4 } });
    expect(series.status).toBe(201);
    const week = (await (await call("GET", "/api/events?from=2026-10-05&to=2026-10-12")).json()) as any;
    expect(week.map((e: any) => e.startAt)).toEqual(["2026-10-05T13:00:00.000Z", "2026-10-07T13:00:00.000Z"]);

    // Um batch com erro não deixa nada pela metade (transação, como no D1).
    const db = getDb(env.DB);
    await expect(db.batch([db.insert(tasks).values({ id: "t-ok", workspaceId: task.workspaceId, title: "ok" }), db.insert(tasks).values({ id: "t-ruim", workspaceId: "nao-existe", title: "x" })])).rejects.toThrow();
    expect(await db.query.tasks.findFirst({ where: (t, { eq }) => eq(t.id, "t-ok") })).toBeUndefined();
  });

  it("faz backup numa pasta, confere e gera o SQL de restauração", async () => {
    const run = await runBackup({ db: getDb(env.DB), env }, "manual");
    expect(run.status).toBe("ok");
    const object = await env.BACKUPS!.get(run.objectKey!);
    const snapshot = await unpackSnapshot(new Uint8Array(await object!.arrayBuffer()), KEY);
    expect(snapshot.tables.tasks.rows).toHaveLength(1);
    expect(snapshot.migrations).toContain("0006_tarefas_detalhe.sql");
    expect(snapshotToStatements(await createSnapshot(env.DB)).length).toBeGreaterThan(3);
  });

  it("entende os crons da Central em UTC", () => {
    expect(cronMatches("*/5 * * * *", new Date("2026-10-05T10:15:00Z"))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date("2026-10-05T10:16:00Z"))).toBe(false);
    expect(cronMatches("0 6 * * *", new Date("2026-10-05T06:00:00Z"))).toBe(true);
    expect(cronMatches("0 6 * * *", new Date("2026-10-05T07:00:00Z"))).toBe(false);
    expect(() => cronMatches("0 6 * * 1", new Date())).toThrow();
  });
});
