// Formato do backup, sem dependências: roda no Worker e no Node (scripts/restaurar-backup.ts).
// Arquivo = "CBK1" + IV (12 bytes) + AES-256-GCM(gzip(JSON do snapshot)).

export interface Snapshot {
  format: "central-backup";
  version: 1;
  createdAt: string;
  migrations: string[];
  tables: Record<string, { columns: string[]; rows: unknown[][] }>;
}

const MAGIC = new TextEncoder().encode("CBK1");

async function importKey(keyBase64: string) {
  const raw = Uint8Array.from(atob(keyBase64.trim().replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY precisa ter 32 bytes em base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function packSnapshot(snapshot: Snapshot, keyBase64: string): Promise<Uint8Array> {
  const gz = await pipe(new TextEncoder().encode(JSON.stringify(snapshot)), new CompressionStream("gzip"));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyBase64), gz));
  const out = new Uint8Array(MAGIC.length + iv.length + cipher.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(cipher, MAGIC.length + iv.length);
  return out;
}

export async function unpackSnapshot(file: Uint8Array, keyBase64: string): Promise<Snapshot> {
  if (file.length < 17 || MAGIC.some((b, i) => file[i] !== b)) throw new Error("arquivo não é um backup da Central");
  const iv = file.slice(4, 16);
  let gz: Uint8Array;
  try {
    gz = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await importKey(keyBase64), file.slice(16)));
  } catch {
    throw new Error("não foi possível decifrar: chave errada ou arquivo alterado");
  }
  const snapshot = JSON.parse(new TextDecoder().decode(await pipe(gz, new DecompressionStream("gzip")))) as Snapshot;
  if (snapshot.format !== "central-backup" || snapshot.version !== 1) throw new Error("versão de backup desconhecida");
  return snapshot;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("número inválido no backup");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Comandos SQL que deixam o banco igual ao snapshot: apaga as tabelas do backup e reinsere as linhas.
 * As chaves estrangeiras são conferidas só no fim da transação, então a ordem das tabelas não importa.
 * Rode num banco com as migrations já aplicadas.
 */
export function snapshotToStatements(snapshot: Snapshot, rowsPerInsert = 50): string[] {
  const names = Object.keys(snapshot.tables);
  const out = ["PRAGMA defer_foreign_keys = true"];
  for (const name of names) out.push(`DELETE FROM ${ident(name)}`);
  for (const name of names) {
    const { columns, rows } = snapshot.tables[name];
    const cols = columns.map(ident).join(", ");
    for (let i = 0; i < rows.length; i += rowsPerInsert) {
      const values = rows.slice(i, i + rowsPerInsert).map((r) => `(${r.map(literal).join(", ")})`);
      out.push(`INSERT INTO ${ident(name)} (${cols}) VALUES ${values.join(", ")}`);
    }
  }
  return out;
}
