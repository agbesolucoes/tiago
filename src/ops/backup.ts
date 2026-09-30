import { desc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { appErrors, backupRuns } from "../db/schema";
import type { Env } from "../env";
import { newId } from "../lib/crypto";
import { errorMessage, log, recordError } from "../lib/log";
import { packSnapshot, unpackSnapshot, type Snapshot } from "./snapshot";

/** Tabelas que não entram no backup: sessões e dados de vida curta, que não fazem falta numa restauração. */
const EXCLUDED = new Set(["sessions", "telegram_link_codes", "processed_updates", "pending_confirmations", "backup_runs", "app_errors", "d1_migrations"]);
const PAGE = 1000;
export const RETENTION_DAYS = 30;
const KEEP_AT_LEAST = 7;
export const BACKUP_PREFIX = "d1/";

export function backupConfigured(env: Env) {
  return !!env.BACKUPS && !!env.BACKUP_ENCRYPTION_KEY;
}

/** Lê todas as tabelas do banco (em páginas) para um snapshot. */
export async function createSnapshot(d1: D1Database, now = Date.now()): Promise<Snapshot> {
  const { results } = await d1
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .all<{ name: string }>();
  const tables: Snapshot["tables"] = {};
  for (const { name } of results) {
    if (EXCLUDED.has(name)) continue;
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const cols = await d1.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).bind(name).all<{ name: string }>();
    const columns = cols.results.map((c) => c.name);
    const rows: unknown[][] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await d1.prepare(`SELECT * FROM ${quoted} ORDER BY rowid LIMIT ? OFFSET ?`).bind(PAGE, offset).raw();
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    tables[name] = { columns, rows };
  }
  let migrations: string[] = [];
  try {
    migrations = (await d1.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map((r) => r.name);
  } catch {
    // Banco sem a tabela de controle do wrangler: segue sem a lista.
  }
  return { format: "central-backup", version: 1, createdAt: new Date(now).toISOString(), migrations, tables };
}

const counts = (s: Snapshot) => Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, v.rows.length]));

/**
 * Gera o backup cifrado no R2, confere lendo o arquivo de volta e aplica a retenção.
 * Cada execução fica em backup_runs; falhas também vão para app_errors.
 */
export async function runBackup(deps: { db: Db; env: Env; now?: () => number }, trigger: "cron" | "manual") {
  const { db, env } = deps;
  const now = deps.now?.() ?? Date.now();
  if (!backupConfigured(env)) throw new Error("backup não configurado: faltam o bucket BACKUPS ou a BACKUP_ENCRYPTION_KEY");
  const id = newId();
  await db.insert(backupRuns).values({ id, trigger, startedAt: now });
  try {
    const snapshot = await createSnapshot(env.DB, now);
    const file = await packSnapshot(snapshot, env.BACKUP_ENCRYPTION_KEY!);
    const key = `${BACKUP_PREFIX}${new Date(now).toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}.cbk`;
    const tables = counts(snapshot);
    await env.BACKUPS!.put(key, file, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { runId: id } });

    // Só vale como backup se o arquivo gravado abre com a chave e tem as mesmas linhas.
    const stored = await env.BACKUPS!.get(key);
    if (!stored) throw new Error("o arquivo não apareceu no R2 depois de gravado");
    const check = counts(await unpackSnapshot(new Uint8Array(await stored.arrayBuffer()), env.BACKUP_ENCRYPTION_KEY!));
    if (JSON.stringify(check) !== JSON.stringify(tables)) throw new Error("conferência do backup não bateu com o banco");

    await db.update(backupRuns).set({ status: "ok", objectKey: key, size: file.length, tables, finishedAt: Date.now() }).where(eq(backupRuns.id, id));
    const removed = await applyRetention(env.BACKUPS!, now);
    log("info", "backup.ok", { id, key, size: file.length, rows: Object.values(tables).reduce((a, b) => a + b, 0), removed });
  } catch (e) {
    await db.update(backupRuns).set({ status: "failed", error: errorMessage(e).slice(0, 500), finishedAt: Date.now() }).where(eq(backupRuns.id, id));
    await recordError(db, "backup", e);
  }
  return (await db.query.backupRuns.findFirst({ where: eq(backupRuns.id, id) }))!;
}

/** Apaga arquivos com mais de 30 dias, mantendo sempre os 7 mais recentes. */
export async function applyRetention(bucket: R2Bucket, now: number) {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // A data está no nome do arquivo; sem ela, vale a data de gravação no R2.
  const dated = objects.map((o) => {
    const m = /^d1\/(\d{4}-\d{2}-\d{2})T/.exec(o.key);
    return { key: o.key, at: m ? Date.parse(m[1]) : o.uploaded.getTime() };
  });
  dated.sort((a, b) => b.at - a.at);
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  const old = dated.slice(KEEP_AT_LEAST).filter((o) => o.at < cutoff);
  if (old.length) await bucket.delete(old.map((o) => o.key));
  return old.length;
}

export async function recentRuns(db: Db, limit = 5) {
  return db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit);
}

/** Limpeza diária: erros com mais de 30 dias e histórico de backups com mais de 90. */
export async function pruneOps(db: Db, now = Date.now()) {
  await db.batch([
    db.delete(appErrors).where(lt(appErrors.createdAt, now - 30 * 86_400_000)),
    db.delete(backupRuns).where(lt(backupRuns.startedAt, now - 90 * 86_400_000)),
  ]);
}
