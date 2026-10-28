// Moradores num raio pelo WorldPop, consultado pelo servidor para o analista de mercado.
// O WorldPop passou a responder com avisos de PHP antes do JSON, o que quebra a leitura e tira o cabeçalho
// de CORS; por isso o navegador não consegue mais consultá-lo direto e a Central faz a consulta no lugar dele.

const API = "https://api.worldpop.org/v1";
const POLL_MS = 3000;
const MAX_POLLS = 30;

/** Trocado nos testes por um serviço falso. */
export const worldpopFetch: { impl: typeof fetch; sleep: (ms: number) => Promise<void> } = {
  impl: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class WorldPopError extends Error {}

/** Polígono de 48 lados aproximando o círculo (mesma conta do analista). */
export function circleGeoJson(lat: number, lon: number, radius: number, n = 48) {
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    const dy = (radius * Math.cos(t)) / 110540;
    const dx = (radius * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180));
    ring.push([+(lon + dx).toFixed(6), +(lat + dy).toFixed(6)]);
  }
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }] };
}

/** Lê o JSON mesmo com avisos em HTML antes ou lixo depois. */
export function lenientJson(text: string): Record<string, unknown> | null {
  const start = text.search(/\{\s*"/);
  if (start < 0) return null;
  // Do fim para o começo: o primeiro fechamento que forma um JSON válido.
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* tenta um fechamento antes */
    }
  }
  return null;
}

async function get(url: string) {
  let res: Response;
  try {
    res = await worldpopFetch.impl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(90_000) });
  } catch {
    throw new WorldPopError("o WorldPop não respondeu");
  }
  if (!res.ok) throw new WorldPopError(`o WorldPop falhou (HTTP ${res.status})`);
  const j = lenientJson(await res.text());
  if (!j) throw new WorldPopError("o WorldPop respondeu sem dados");
  if (j.error) throw new WorldPopError(`o WorldPop recusou (${String(j.error_message ?? j.error)})`);
  return j as { status?: string; taskid?: string; data?: { total_population?: number } };
}

/** Moradores estimados (grade de 100 m, 2020) num círculo de `radius` metros. */
export async function worldpopPopulation(lat: number, lon: number, radius: number) {
  const gj = JSON.stringify(circleGeoJson(lat, lon, radius));
  let j = await get(`${API}/services/stats?dataset=wpgppop&year=2020&geojson=${encodeURIComponent(gj)}&runasync=false`);
  // Às vezes a resposta vem com status "started" mas já com o total; nesse caso não precisa consultar a tarefa.
  for (let i = 0; i < MAX_POLLS && typeof j.data?.total_population !== "number" && j.status !== "finished" && j.taskid; i++) {
    await worldpopFetch.sleep(POLL_MS);
    j = await get(`${API}/tasks/${j.taskid}`);
  }
  const v = j.data?.total_population;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new WorldPopError("o WorldPop não devolveu a população");
  return v;
}
