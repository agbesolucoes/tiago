import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integrationAccounts, users } from "../src/db/schema";
import { googleFetch } from "../src/integrations/google-client";
import { newId } from "../src/lib/crypto";
import { encryptSecret } from "../src/lib/secret";
import { runBackup } from "../src/ops/backup";
import { copyBackupToDrive } from "../src/ops/drive-backup";
import { FakeGoogle } from "./fake-google";
import { db, makeUser } from "./helpers";
import { eq } from "drizzle-orm";

const DRIVE = "https://www.googleapis.com/auth/drive.file";
let g: FakeGoogle;
const realFetch = googleFetch.impl;
beforeEach(() => {
  g = new FakeGoogle();
  googleFetch.impl = g.fetch;
});
afterEach(() => {
  googleFetch.impl = realFetch;
});

/** Dono da instalação: o primeiro e-mail de ALLOWED_EMAILS, com o Google conectado. */
async function owner(opts: { email?: string; drive?: boolean } = {}) {
  const email = opts.email ?? `dono-${newId()}@exemplo.com`;
  const u = await makeUser();
  await db().update(users).set({ email }).where(eq(users.id, u.id));
  await db()
    .insert(integrationAccounts)
    .values({
      id: newId(),
      workspaceId: u.workspaceId,
      userId: u.id,
      provider: "google",
      externalSub: `g-${u.id}`,
      email,
      scopes: opts.drive === false ? "openid email" : `openid email ${DRIVE}`,
      refreshTokenEnc: await encryptSecret("rt", env.TOKEN_ENCRYPTION_KEY),
    });
  return { ...u, email, e: { ...env, ALLOWED_EMAILS: `${email},outra@exemplo.com`, BACKUP_TO_DRIVE: "true" } };
}

const inBackups = () => {
  const folder = [...g.files.values()].find((f) => f.name === "Backups");
  return folder ? [...g.files.values()].filter((f) => f.parents.includes(folder.id)) : [];
};

describe("cópia do backup no Drive", () => {
  it("envia o arquivo cifrado para Central de Organização/Backups do dono", async () => {
    const o = await owner();
    const run = await runBackup({ db: db(), env: o.e }, "manual");
    expect(run.status).toBe("ok");
    const files = inBackups();
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe(`central-${run.objectKey!.split("/").pop()}`);
    expect(Number(files[0].size)).toBe(run.size);
    const root = [...g.files.values()].find((f) => f.name === "Central de Organização")!;
    const backups = [...g.files.values()].find((f) => f.name === "Backups")!;
    expect(backups.parents).toEqual([root.id]);
    // Nenhuma permissão de compartilhamento é tocada.
    expect(g.calls.some((c) => c.path.includes("/permissions"))).toBe(false);
  });

  it("mantém 30 dias e nunca menos que as 7 cópias mais novas", async () => {
    const o = await owner();
    const day = 86_400_000;
    const now = Date.parse("2026-09-30T06:00:00Z");
    for (let i = 40; i >= 1; i -= 3) {
      const at = new Date(now - i * day).toISOString().replace(/[:.]/g, "-");
      await copyBackupToDrive({ db: db(), env: o.e }, `central-${at}-x.cbk`, new Uint8Array([1, 2, 3]), now - i * day);
    }
    await copyBackupToDrive({ db: db(), env: o.e }, "central-2026-09-30T06-00-00-000Z-x.cbk", new Uint8Array([1]), now);
    const dates = inBackups()
      .map((f) => f.name.slice(8, 18))
      .sort();
    expect(dates[0] >= "2026-08-31").toBe(true);
    expect(dates.length).toBeGreaterThanOrEqual(7);
    expect(dates).toContain("2026-09-30");
  });

  it("sem Drive do dono, pula a cópia e o backup continua valendo", async () => {
    const o = await owner({ drive: false });
    const run = await runBackup({ db: db(), env: o.e }, "manual");
    expect(run.status).toBe("ok");
    expect(inBackups()).toHaveLength(0);
  });

  it("falha no Drive vira erro registrado, sem derrubar o backup", async () => {
    const o = await owner();
    g.failNext.set("POST drive", 500);
    const run = await runBackup({ db: db(), env: o.e }, "manual");
    expect(run.status).toBe("ok");
    const errors = await db().query.appErrors.findMany();
    expect(errors.some((e) => e.source === "backup drive")).toBe(true);
  });
});
