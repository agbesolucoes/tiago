// Aplica o SQL gerado por restaurar-backup.mjs num banco SQLite do servidor Node (Hostinger).
// Pare o app antes. Uso: node scripts/restaurar-sqlite.mjs <restauracao.sql> <banco.db> [pasta-das-migrations]
import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [sqlFile, dbFile, migrations = "migrations"] = process.argv.slice(2);
if (!sqlFile || !dbFile) {
  console.error("Uso: node scripts/restaurar-sqlite.mjs <restauracao.sql> <banco.db> [pasta-das-migrations]");
  process.exit(1);
}

const db = new Database(dbFile);
db.pragma("foreign_keys = ON");

// Banco novo ou antigo: aplica as migrações que faltam, como o servidor faz ao iniciar.
db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
const done = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((r) => r.name));
if (existsSync(migrations)) {
  for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    db.transaction(() => {
      for (const part of readFileSync(join(migrations, f), "utf8").split("--> statement-breakpoint")) if (part.trim()) db.exec(part);
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
    })();
  }
}

// Tudo numa transação: se algo falhar, o banco fica como estava.
db.exec("BEGIN");
try {
  db.exec(readFileSync(sqlFile, "utf8"));
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("A restauração falhou e nada foi alterado:", e.message);
  process.exit(1);
}
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
for (const { name } of tables) console.log(`${name}: ${db.prepare(`SELECT count(*) n FROM "${name}"`).get().n}`);
db.close();
