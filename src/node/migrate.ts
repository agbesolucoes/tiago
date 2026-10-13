import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteD1 } from "./d1-sqlite";

/**
 * Aplica as migrações de `migrations/` que ainda não rodaram, na ordem do nome.
 * Usa a mesma tabela de controle do wrangler (d1_migrations), então o backup lista as migrações como na Cloudflare.
 */
export function applyMigrations(db: SqliteD1, dir: string) {
  const sqlite = db.sqlite;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const done = new Set((sqlite.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    sqlite.transaction(() => {
      for (const part of sql.split("--> statement-breakpoint")) if (part.trim()) sqlite.exec(part);
      sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
    })();
    applied.push(file);
  }
  return applied;
}
