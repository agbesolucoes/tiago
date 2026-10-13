import { and, eq } from "drizzle-orm";
import { allowedEmails } from "../auth/session";
import type { Db } from "../db/client";
import { integrationAccounts, users } from "../db/schema";
import type { Env } from "../env";
import { driveEnabled, driveFor, ensureFolders } from "../integrations/drive";
import { GoogleError } from "../integrations/google-client";
import { log } from "../lib/log";
import { RETENTION_DAYS } from "./backup";

// Cópia de cada backup no Google Drive do dono da instalação (primeiro e-mail de ALLOWED_EMAILS),
// numa pasta "Backups" dentro de "Central de Organização". Serve para quem roda a Central num
// servidor próprio: se o disco do servidor se perder, os backups continuam no Drive.

export const BACKUP_FOLDER = "Backups";
const KEEP_AT_LEAST = 7;

export const driveBackupEnabled = (env: Env) => env.BACKUP_TO_DRIVE === "true";

type Deps = { db: Db; env: Env; fetcher?: typeof fetch };

/** Conta Google do dono da instalação, se estiver conectada com o Drive. */
async function ownerAccount(db: Db, env: Env) {
  const email = allowedEmails(env.ALLOWED_EMAILS)[0];
  if (!email) return null;
  const rows = await db
    .select({ account: integrationAccounts })
    .from(integrationAccounts)
    .innerJoin(users, eq(users.id, integrationAccounts.userId))
    .where(and(eq(users.email, email), eq(integrationAccounts.status, "active")));
  return rows.map((r) => r.account).find(driveEnabled) ?? null;
}

/**
 * Envia o arquivo cifrado ao Drive e apaga as cópias com mais de 30 dias, mantendo sempre as 7 mais novas.
 * Devolve o id do arquivo no Drive, ou null quando o Drive do dono não está conectado.
 */
export async function copyBackupToDrive(deps: Deps, name: string, file: Uint8Array, now = Date.now()) {
  const account = await ownerAccount(deps.db, deps.env);
  if (!account) {
    log("warn", "backup.drive.skipped", { reason: "o dono da instalação não conectou o Google Drive" });
    return null;
  }
  const folders = await ensureFolders(deps, account);
  const drive = await driveFor(deps, account);

  let folderId = account.driveFolders?.backups;
  if (folderId) {
    try {
      if ((await drive.getFile(folderId)).trashed) folderId = undefined;
    } catch (e) {
      if (!(e instanceof GoogleError && e.status === 404)) throw e;
      folderId = undefined;
    }
  }
  if (!folderId) {
    folderId = ((await drive.findFolder(BACKUP_FOLDER, folders.root)) ?? (await drive.createFolder(BACKUP_FOLDER, folders.root))).id;
    const driveFolders = { ...folders, backups: folderId };
    await deps.db.update(integrationAccounts).set({ driveFolders, updatedAt: Date.now() }).where(eq(integrationAccounts.id, account.id));
  }

  const mimeType = "application/octet-stream";
  const session = await drive.startUpload({ name, parentId: folderId, mimeType, size: file.length });
  const uploaded = await drive.upload(session, file.slice().buffer, file.length, mimeType);

  // Retenção igual à do servidor. A data vem do nome do arquivo (central-AAAA-MM-DDT...).
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  const copies = (await drive.listFiles(folderId))
    .map((f) => ({ id: f.id, at: Date.parse(/(\d{4}-\d{2}-\d{2})T/.exec(f.name)?.[1] ?? "") }))
    .filter((f) => !Number.isNaN(f.at))
    .sort((a, b) => b.at - a.at);
  const old = copies.slice(KEEP_AT_LEAST).filter((f) => f.at < cutoff);
  for (const f of old) await drive.deleteFile(f.id);

  log("info", "backup.drive.ok", { fileId: uploaded.id, removed: old.length });
  return uploaded.id;
}
