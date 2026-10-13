// Agendador mínimo no lugar dos Cron Triggers da Cloudflare. Entende "minuto hora * * *"
// com número, "*" ou "*/n", sempre em UTC, como na Cloudflare.

function field(spec: string, value: number) {
  if (spec === "*") return true;
  const step = /^\*\/(\d+)$/.exec(spec);
  if (step) return value % Number(step[1]) === 0;
  return spec.split(",").some((n) => Number(n) === value);
}

export function cronMatches(cron: string, at: Date) {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  if (dom !== "*" || mon !== "*" || dow !== "*") throw new Error(`cron não suportado: ${cron}`);
  return field(min, at.getUTCMinutes()) && field(hour, at.getUTCHours());
}

/**
 * Chama `run(cron)` no começo de cada minuto em que o cron bate. Um cron que ainda está rodando
 * não é disparado de novo por cima. Devolve a função que para o agendador.
 */
export function startScheduler(crons: string[], run: (cron: string, at: Date) => Promise<void>) {
  for (const c of crons) cronMatches(c, new Date()); // valida já na partida
  const running = new Set<string>();
  let timer: NodeJS.Timeout;
  const tick = () => {
    const now = new Date();
    now.setUTCSeconds(0, 0);
    for (const cron of crons) {
      if (!cronMatches(cron, now) || running.has(cron)) continue;
      running.add(cron);
      run(cron, now)
        .catch((e) => console.error(JSON.stringify({ level: "error", event: "cron.failed", cron, error: String(e) })))
        .finally(() => running.delete(cron));
    }
    schedule();
  };
  const schedule = () => {
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  schedule();
  return () => clearTimeout(timer);
}
