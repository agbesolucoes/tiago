// A API devolve ISO UTC e aceita "AAAA-MM-DDTHH:mm" como hora local do workspace.

let zone = "America/Sao_Paulo";
export function setTimeZone(tz: string) {
  zone = tz;
}

function parts(iso: string | Date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(typeof iso === "string" ? new Date(iso) : iso);
  const get = (t: string) => f.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** Data local (AAAA-MM-DD) no fuso do workspace. */
export const localDate = (iso: string | Date) => parts(iso).date;
/** Hora local (HH:mm) no fuso do workspace. */
export const localTime = (iso: string | Date) => parts(iso).time;
export const today = () => localDate(new Date());

export function addDays(date: string, n: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Segunda-feira da semana da data. */
export function startOfWeek(date: string) {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

export function formatDay(date: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("pt-BR", { ...opts, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

/** "Hoje 14:00", "Amanhã", "12 out" etc. */
export function formatDue(iso: string) {
  const d = localDate(iso);
  const t = localTime(iso);
  const time = t === "00:00" ? "" : ` ${t}`;
  const now = today();
  if (d === now) return `Hoje${time}`;
  if (d === addDays(now, 1)) return `Amanhã${time}`;
  if (d === addDays(now, -1)) return `Ontem${time}`;
  const sameYear = d.slice(0, 4) === now.slice(0, 4);
  return formatDay(d, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }) + time;
}

export const isOverdue = (iso: string | null, done: boolean) => !done && !!iso && new Date(iso).getTime() < Date.now();
