// Traz a versão mais nova do analista de mercado Omega para public/analista/index.html.
// O analista é desenvolvido em github.com/agbesolucoes/omega-analista-mercado; aqui fica uma cópia servida pela Central.
import { writeFile } from "node:fs/promises";

const URL_ANALISTA = "https://raw.githubusercontent.com/agbesolucoes/omega-analista-mercado/main/index.html";
const res = await fetch(URL_ANALISTA);
if (!res.ok) throw new Error(`não baixou o analista: HTTP ${res.status}`);
const html = await res.text();
if (!html.includes("omega:estudo")) throw new Error("a versão baixada não tem a integração com a Central");
await writeFile(new URL("../public/analista/index.html", import.meta.url), html);
console.log(`Analista atualizado (${html.length.toLocaleString("pt-BR")} bytes).`);
