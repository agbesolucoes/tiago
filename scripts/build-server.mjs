// Empacota o servidor Node (src/node/server.ts) em dist/server/index.mjs.
// Só o better-sqlite3 fica de fora, porque traz o binário nativo do SQLite.
import { build } from "esbuild";

await build({
  entryPoints: ["src/node/server.ts"],
  outfile: "dist/server/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3"],
  // Algumas dependências usam require(); em ESM ele precisa ser criado.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
