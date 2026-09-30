// Datas persistidas em UTC (ms). Entradas sem offset são interpretadas no fuso do workspace.

const OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Offset do fuso em ms para um instante UTC (positivo a leste de Greenwich). */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converte "2026-10-01T09:00" (hora local do fuso) ou um ISO com offset para ms UTC.
 * Retorna null se o texto não for uma data válida.
 */
export function parseDateTime(input: string, timeZone: string): number | null {
  if (OFFSET_RE.test(input)) {
    const ms = Date.parse(input);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = LOCAL_RE.exec(input);
  if (!m) return null;
  const [y, mo, d, h = "0", mi = "0", s = "0"] = m.slice(1);
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const check = new Date(wall);
  if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) return null;
  // Duas passadas cobrem mudanças de horário de verão.
  let utc = wall - tzOffsetMs(wall, timeZone);
  utc = wall - tzOffsetMs(utc, timeZone);
  return utc;
}

export function toIso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/** Início e fim (exclusivo) do dia local que contém o instante, em ms UTC. */
export function localDayRange(utcMs: number, timeZone: string): [number, number] {
  const local = new Date(utcMs + tzOffsetMs(utcMs, timeZone));
  const day = local.toISOString().slice(0, 10);
  const start = parseDateTime(day, timeZone)!;
  const next = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1))
    .toISOString()
    .slice(0, 10);
  return [start, parseDateTime(next, timeZone)!];
}
