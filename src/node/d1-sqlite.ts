import Database from "better-sqlite3";

// Implementa, sobre um arquivo SQLite local, a parte da API do D1 que a Central usa
// (prepare/bind/all/raw/first/run/batch/exec). Assim o mesmo código roda na Cloudflare e no Node.

type Value = null | number | string | bigint | Buffer;

/** O D1 aceita booleanos, undefined e ArrayBuffer; o SQLite do Node não. */
function toSqlite(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === "number" || typeof v === "string" || typeof v === "bigint" || Buffer.isBuffer(v)) return v as Value;
  throw new TypeError(`tipo não suportado no banco: ${typeof v}`);
}

/** Buffers voltam como ArrayBuffer, como no D1. */
function fromSqlite(v: unknown) {
  if (!Buffer.isBuffer(v)) return v;
  const b = v as Buffer;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
const mapRow = (row: Record<string, unknown>) => {
  for (const k in row) row[k] = fromSqlite(row[k]);
  return row;
};

const meta = (changes = 0, lastRowId = 0) => ({ duration: 0, changes, last_row_id: lastRowId, changed_db: changes > 0, size_after: 0, rows_read: 0, rows_written: changes });

class Statement {
  constructor(
    private db: SqliteD1,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values.map(toSqlite));
  }

  /** Executa e devolve no formato de D1Result. */
  execute() {
    const stmt = this.db.statement(this.sql);
    if (stmt.reader) {
      const results = (stmt.all(...this.params) as Record<string, unknown>[]).map(mapRow);
      return { success: true as const, results, meta: meta() };
    }
    const info = stmt.run(...this.params);
    return { success: true as const, results: [], meta: meta(info.changes, Number(info.lastInsertRowid)) };
  }

  async all<T = Record<string, unknown>>() {
    return this.execute() as unknown as D1Result<T>;
  }

  async run<T = Record<string, unknown>>() {
    return this.execute() as unknown as D1Result<T>;
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.execute().results[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.db.statement(this.sql);
    if (!stmt.reader) {
      stmt.run(...this.params);
      return [];
    }
    const rows = (stmt.raw(true).all(...this.params) as unknown[][]).map((r) => r.map(fromSqlite));
    stmt.raw(false);
    if (opts?.columnNames) return [stmt.columns().map((c) => c.name) as T, ...(rows as T[])];
    return rows as T[];
  }
}

export class SqliteD1 {
  readonly sqlite: Database.Database;
  private cache = new Map<string, Database.Statement>();

  constructor(file: string) {
    this.sqlite = new Database(file);
    // WAL deixa leituras e escritas conviverem; foreign keys ligadas como no D1.
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
  }

  statement(sql: string) {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.sqlite.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  prepare(sql: string) {
    return new Statement(this, sql);
  }

  /** Como no D1: tudo numa transação; se uma falhar, nada fica gravado. */
  async batch(statements: Statement[]) {
    return this.sqlite.transaction(() => statements.map((s) => s.execute()))();
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this.sqlite.close();
  }

  /** Para passar onde o código espera o binding D1. */
  asD1() {
    return this as unknown as D1Database;
  }
}
