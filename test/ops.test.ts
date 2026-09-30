import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { appErrors, backupRuns, events, ideas, projects, tasks, users } from "../src/db/schema";
import { newId } from "../src/lib/crypto";
import { recordError } from "../src/lib/log";
import { applyRetention, createSnapshot, runBackup } from "../src/ops/backup";
import { packSnapshot, snapshotToStatements, unpackSnapshot } from "../src/ops/snapshot";
import { call, db, json, makeUser } from "./helpers";

const KEY = env.BACKUP_ENCRYPTION_KEY!;

/** Dono da instalação: o primeiro e-mail de ALLOWED_EMAILS (dono@exemplo.com nos testes). */
async function instanceOwner() {
  const u = await makeUser();
  await db().delete(users).where(eq(users.email, "dono@exemplo.com"));
  await db().update(users).set({ email: "dono@exemplo.com" }).where(eq(users.id, u.id));
  return u;
}

async function seed(workspaceId: string) {
  const projectId = newId();
  await db().insert(projects).values({ id: projectId, workspaceId, title: "Reforma d'O Escritório" });
  await db().insert(tasks).values({ id: newId(), workspaceId, projectId, title: "Tarefa com 'aspas' e acentuação", dueAt: 1_790_000_000_000 });
  await db().insert(ideas).values({ id: newId(), workspaceId, title: "Ideia", origin: null });
  await db().insert(events).values({ id: newId(), workspaceId, projectId, title: "Reunião", startAt: 1_790_000_000_000, endAt: 1_790_003_600_000, timezone: "America/Sao_Paulo" });
}

describe("verificação de saúde", () => {
  it("responde sem login e devolve o id da requisição", async () => {
    const res = await call(null, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("backup", () => {
  it("grava cifrado no R2, confere e registra a execução", async () => {
    const u = await makeUser();
    await seed(u.workspaceId);
    const run = await runBackup({ db: db(), env }, "manual");
    expect(run.status).toBe("ok");
    expect(run.tables!.tasks).toBeGreaterThanOrEqual(1);
    expect(run.tables).not.toHaveProperty("sessions");

    const object = await env.BACKUPS!.get(run.objectKey!);
    const bytes = new Uint8Array(await object!.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain("acentuação");
    const snapshot = await unpackSnapshot(bytes, KEY);
    expect(snapshot.migrations.at(-1)).toMatch(/operacao/);
    expect(snapshot.tables.tasks.columns).toContain("title");
  });

  it("recusa chave errada e arquivo adulterado", async () => {
    const file = await packSnapshot(await createSnapshot(env.DB), KEY);
    await expect(unpackSnapshot(file, "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")).rejects.toThrow("decifrar");
    const tampered = file.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(unpackSnapshot(tampered, KEY)).rejects.toThrow("decifrar");
    await expect(unpackSnapshot(new TextEncoder().encode("qualquer coisa"), KEY)).rejects.toThrow("não é um backup");
  });

  it("restaura o banco a partir do arquivo", async () => {
    const u = await makeUser();
    await seed(u.workspaceId);
    const before = await db().select().from(tasks).where(eq(tasks.workspaceId, u.workspaceId));
    const run = await runBackup({ db: db(), env }, "manual");
    const snapshot = await unpackSnapshot(new Uint8Array(await (await env.BACKUPS!.get(run.objectKey!))!.arrayBuffer()), KEY);

    // Perda de dados depois do backup.
    await db().delete(tasks).where(eq(tasks.workspaceId, u.workspaceId));
    await db().delete(projects).where(eq(projects.workspaceId, u.workspaceId));
    await db().insert(tasks).values({ id: newId(), workspaceId: u.workspaceId, title: "criada depois do backup" });

    await env.DB.batch(snapshotToStatements(snapshot).map((s) => env.DB.prepare(s)));
    const after = await db().select().from(tasks).where(eq(tasks.workspaceId, u.workspaceId));
    expect(after).toEqual(before);
    expect(await db().select().from(projects).where(eq(projects.workspaceId, u.workspaceId))).toHaveLength(1);
    // O histórico de backups não faz parte do backup e continua lá.
    expect(await db().query.backupRuns.findFirst({ where: eq(backupRuns.id, run.id) })).toBeTruthy();
  });

  it("mantém 30 dias e nunca menos que os 7 mais recentes", async () => {
    const now = Date.UTC(2026, 9, 30);
    const put = (day: string) => env.BACKUPS!.put(`d1/${day}T06-00-00-000Z-x.cbk`, "x");
    const old = ["2026-08-01", "2026-08-15", "2026-09-10"];
    const recent = ["2026-10-01", "2026-10-05", "2026-10-10", "2026-10-15", "2026-10-20", "2026-10-25", "2026-10-29"];
    for (const d of [...old, ...recent]) await put(d);
    await applyRetention(env.BACKUPS!, now);
    const left = (await env.BACKUPS!.list({ prefix: "d1/" })).objects.map((o) => o.key.slice(3, 13));
    for (const d of recent) expect(left).toContain(d);
    for (const d of old) expect(left).not.toContain(d);

    // Sem backups novos, os antigos ficam: nunca sobram menos de 7.
    const bucket = env.BACKUPS!;
    for (const o of (await bucket.list({ prefix: "d1/" })).objects) await bucket.delete(o.key);
    for (const d of ["2026-01-01", "2026-02-01", "2026-03-01"]) await put(d);
    await applyRetention(bucket, now);
    expect((await bucket.list({ prefix: "d1/" })).objects).toHaveLength(3);
  });

  it("falha registrada quando o R2 não guarda o arquivo", async () => {
    const broken = { ...env, BACKUPS: { ...env.BACKUPS!, put: async () => null, get: async () => null } as unknown as R2Bucket };
    const run = await runBackup({ db: db(), env: broken }, "cron");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("não apareceu");
    const [err] = await db().select().from(appErrors).where(eq(appErrors.source, "backup"));
    expect(err.message).toContain("não apareceu");
  });
});

describe("tela de operação", () => {
  it("é só do dono da instalação", async () => {
    const owner = await makeUser();
    const member = await makeUser({ workspaceId: owner.workspaceId, role: "member" });
    expect((await call(owner, "GET", "/api/ops/status")).status).toBe(403);
    expect((await call(member, "GET", "/api/ops/status")).status).toBe(403);
    expect((await call(member, "POST", "/api/ops/backup", {})).status).toBe(403);
  });

  it("mostra backups e erros, faz backup na hora e baixa o arquivo", async () => {
    const admin = await instanceOwner();
    await recordError(db(), "teste", new Error("falha simulada"), "req-1");
    const res = await call(admin, "POST", "/api/ops/backup", {});
    expect(res.status).toBe(201);
    const run = await json(res);
    expect(run).toMatchObject({ status: "ok", trigger: "manual", downloadable: true });

    const status = await json(await call(admin, "GET", "/api/ops/status"));
    expect(status.backups.configured).toBe(true);
    expect(status.backups.recent[0].id).toBe(run.id);
    expect(status.errors.last24h).toBeGreaterThanOrEqual(1);
    expect(status.errors.recent.some((e: any) => e.message === "falha simulada" && e.requestId === "req-1")).toBe(true);

    const file = await call(admin, "GET", `/api/ops/backups/${run.id}/download`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/attachment; filename="central-.*\.cbk"/);
    const snapshot = await unpackSnapshot(new Uint8Array(await file.arrayBuffer()), KEY);
    expect(snapshot.format).toBe("central-backup");
  });
});
