import { eq } from "drizzle-orm";
import { integrationAccounts } from "../db/schema";
import { DRIVE_SCOPE } from "../auth/google";
import { accessTokenFor, type SyncDeps } from "./calendar-sync";
import { DriveClient, GoogleError, googleFetch, type DriveFile } from "./google-client";

type Account = typeof integrationAccounts.$inferSelect;

export const ROOT_FOLDER = "Central de Organização";
export const SUBFOLDERS = { project: "Projetos", event: "Compromissos", idea: "Ideias", general: "Documentos gerais" } as const;
type FolderKey = keyof typeof SUBFOLDERS;

export const driveEnabled = (account: Account) => account.scopes.split(" ").includes(DRIVE_SCOPE);

export class DriveUnavailable extends Error {}

export async function driveFor(deps: SyncDeps, account: Account) {
  if (account.status !== "active") throw new DriveUnavailable("A conexão com o Google não está ativa.");
  if (!driveEnabled(account)) throw new DriveUnavailable("Conecte o Google de novo e autorize o Drive.");
  return new DriveClient(await accessTokenFor(deps, account), deps.fetcher ?? googleFetch.impl);
}

async function alive(drive: DriveClient, id: string | undefined) {
  if (!id) return false;
  try {
    const f = await drive.getFile(id);
    return !f.trashed;
  } catch (e) {
    if (e instanceof GoogleError && e.status === 404) return false;
    throw e;
  }
}

/**
 * Cria ou reutiliza a pasta "Central de Organização" e as subpastas. Com drive.file a busca só
 * enxerga pastas criadas pela própria Central. Nada de ACL é alterado.
 */
export async function ensureFolders(deps: SyncDeps, account: Account): Promise<Record<string, string>> {
  const drive = await driveFor(deps, account);
  const folders: Record<string, string> = { ...(account.driveFolders ?? {}) };
  let changed = false;

  if (!(await alive(drive, folders.root))) {
    const root = (await drive.findFolder(ROOT_FOLDER)) ?? (await drive.createFolder(ROOT_FOLDER));
    folders.root = root.id;
    for (const k of Object.keys(SUBFOLDERS)) delete folders[k];
    changed = true;
  }
  for (const [key, name] of Object.entries(SUBFOLDERS)) {
    if (folders[key] && (await alive(drive, folders[key]))) continue;
    const f = (await drive.findFolder(name, folders.root)) ?? (await drive.createFolder(name, folders.root));
    folders[key] = f.id;
    changed = true;
  }
  if (changed) {
    await deps.db.update(integrationAccounts).set({ driveFolders: folders, updatedAt: Date.now() }).where(eq(integrationAccounts.id, account.id));
    account.driveFolders = folders;
  }
  return folders;
}

export function folderKeyFor(parentKind: string, taskHasProject = false): FolderKey {
  if (parentKind === "project" || (parentKind === "task" && taskHasProject)) return "project";
  if (parentKind === "event") return "event";
  if (parentKind === "idea") return "idea";
  return "general";
}

export async function uploadToDrive(
  deps: SyncDeps,
  account: Account,
  file: { name: string; mimeType: string; size: number; body: ReadableStream | ArrayBuffer | Blob; folder: FolderKey },
): Promise<DriveFile> {
  const folders = await ensureFolders(deps, account);
  const drive = await driveFor(deps, account);
  const session = await drive.startUpload({ name: file.name, parentId: folders[file.folder], mimeType: file.mimeType, size: file.size });
  return drive.upload(session, file.body, file.size, file.mimeType);
}
