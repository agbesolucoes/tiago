#!/usr/bin/env node
// Decifra um backup da Central (.cbk) e gera o SQL para restaurar num banco D1.
//
//   BACKUP_ENCRYPTION_KEY=... node scripts/restaurar-backup.mjs central-d1-....cbk restauracao.sql
//
// Depois: veja docs/backup-e-restauracao.md para aplicar num banco separado e conferir.

import { readFile, writeFile } from "node:fs/promises";

const [file, out = "restauracao.sql"] = process.argv.slice(2);
const key = process.env.BACKUP_ENCRYPTION_KEY;
if (!file || !key) {
  console.error("Uso: BACKUP_ENCRYPTION_KEY=... node scripts/restaurar-backup.mjs <arquivo.cbk> [saida.sql]");
  process.exit(1);
}

// src/ops/snapshot.ts não tem dependências; o Node 22.18+ lê TypeScript simples direto.
const { unpackSnapshot, snapshotToStatements } = await import("../src/ops/snapshot.ts");

let snapshot;
try {
  snapshot = await unpackSnapshot(new Uint8Array(await readFile(file)), key);
} catch (e) {
  console.error(`Não foi possível ler o backup: ${e.message}`);
  process.exit(1);
}
const statements = snapshotToStatements(snapshot);
await writeFile(out, statements.map((s) => `${s};`).join("\n") + "\n");

console.log(`Backup de ${snapshot.createdAt}`);
console.log(`Última migration: ${snapshot.migrations.at(-1) ?? "(desconhecida)"}`);
for (const [name, t] of Object.entries(snapshot.tables)) console.log(`  ${name.padEnd(24)} ${t.rows.length} linhas`);
console.log(`SQL gravado em ${out} (${statements.length} comandos).`);
