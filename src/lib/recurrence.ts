// Compromissos recorrentes: regra RRULE (RFC 5545) guardada no evento-mestre e expandida na leitura.
// A expansão acontece em "hora de parede" do fuso do evento, então 9h continua 9h depois do horário de verão.

import { rrulestr } from "rrule";
import { parseDateTime, tzOffsetMs } from "./time";


export const weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof weekdays)[number];
export type Freq = "daily" | "weekly" | "monthly" | "yearly";

/** Repetição no formato da tela. Regras do Google que não cabem aqui ficam como "personalizada". */
export interface Repeat {
  freq: Freq;
  interval: number;
  byDay?: Weekday[];
  until?: string | null; // AAAA-MM-DD, inclusive
  count?: number | null;
}

export interface Series {
  startAt: number;
  endAt: number;
  timezone: string;
  allDay: boolean;
  recurrence: string;
  exdates?: number[] | null;
}

const MAX_OCCURRENCES = 1000;
const DAY = 86_400_000;
const JS_DAY: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** Instante UTC → Date cujos campos UTC são a hora de parede no fuso. */
const toWall = (ms: number, tz: string) => new Date(ms + tzOffsetMs(ms, tz));
const fromWall = (d: Date, tz: string) => parseDateTime(d.toISOString().slice(0, 19), tz)!;
const basic = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

export function weekdayOf(ms: number, tz: string): Weekday {
  return JS_DAY[toWall(ms, tz).getUTCDay()];
}

/** Monta a RRULE (sem o prefixo "RRULE:") a partir da escolha da tela. */
export function toRRule(repeat: Repeat, startAt: number, tz: string, allDay: boolean): string {
  const parts = [`FREQ=${repeat.freq.toUpperCase()}`];
  if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`);
  if (repeat.freq === "weekly") {
    const days = repeat.byDay?.length ? repeat.byDay : [weekdayOf(startAt, tz)];
    parts.push(`BYDAY=${weekdays.filter((d) => days.includes(d)).join(",")}`);
  }
  if (repeat.count) parts.push(`COUNT=${repeat.count}`);
  else if (repeat.until) {
    // UNTIL em UTC (exigência do Google quando o início tem fuso); para dia inteiro, só a data.
    parts.push(allDay ? `UNTIL=${repeat.until.replace(/-/g, "")}` : `UNTIL=${basic(new Date(parseDateTime(`${repeat.until}T23:59:59`, tz)!))}Z`);
  }
  return parts.join(";");
}

/** Lê a RRULE de volta para a tela; null quando é uma regra que a tela não sabe editar. */
export function fromRRule(rule: string, tz: string): Repeat | null {
  const map = new Map(rule.split(";").map((p) => p.split("=") as [string, string]));
  const freq = map.get("FREQ")?.toLowerCase();
  if (!freq || !["daily", "weekly", "monthly", "yearly"].includes(freq)) return null;
  const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]);
  if ([...map.keys()].some((k) => !allowed.has(k))) return null;
  const byDay = map.get("BYDAY")?.split(",");
  if (byDay && (freq !== "weekly" || byDay.some((d) => !(weekdays as readonly string[]).includes(d)))) return null;
  const repeat: Repeat = { freq: freq as Freq, interval: Number(map.get("INTERVAL") ?? 1) };
  if (byDay) repeat.byDay = byDay as Weekday[];
  if (map.get("COUNT")) repeat.count = Number(map.get("COUNT"));
  const until = map.get("UNTIL");
  if (until) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until);
    if (!m) return null;
    if (m[7]) {
      const wall = toWall(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), tz);
      repeat.until = wall.toISOString().slice(0, 10);
    } else repeat.until = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return repeat;
}

/** Regra pronta para expandir em hora de parede: UNTIL em UTC vira hora local. */
function wallRule(series: Series) {
  const rule = series.recurrence.replace(/UNTIL=(\d{8}T\d{6})Z/, (_m, v: string) => {
    const utc = Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15));
    return `UNTIL=${basic(toWall(utc, series.timezone))}`;
  });
  return rrulestr(`RRULE:${rule}`, { dtstart: toWall(series.startAt, series.timezone) });
}

export interface Occurrence {
  start: number;
  end: number;
}

/** Ocorrências que se sobrepõem a [from, to), sem as datas excluídas e as substituídas por exceções. */
export function expand(series: Series, from: number, to: number, skip: Set<number> = new Set()): Occurrence[] {
  const duration = series.endAt - series.startAt;
  const rule = wallRule(series);
  const tz = series.timezone;
  // Margem de um dia em cada ponta cobre a diferença entre hora de parede e UTC.
  const walls = rule.between(new Date(from + tzOffsetMs(from, tz) - duration - DAY), new Date(to + tzOffsetMs(to, tz) + DAY), true);
  const excluded = new Set([...(series.exdates ?? []), ...skip]);
  const out: Occurrence[] = [];
  for (const wall of walls) {
    const start = fromWall(wall, tz);
    const end = start + duration;
    if (end <= from && !(duration === 0 && start === from)) continue;
    if (start >= to) continue;
    if (excluded.has(start)) continue;
    out.push({ start, end });
    if (out.length >= MAX_OCCURRENCES) break;
  }
  return out;
}

/** Fim da última ocorrência, ou null se a série não termina. Usado para filtrar séries no banco. */
export function seriesEnd(series: Series): number | null {
  if (!/(COUNT|UNTIL)=/.test(series.recurrence)) return null;
  const all = wallRule(series).all((_d, i) => i < 5000);
  if (!all.length) return series.endAt;
  return fromWall(all[all.length - 1], series.timezone) + (series.endAt - series.startAt);
}

/** Uma data da série é válida? (para excluir ou editar só uma ocorrência) */
export function isOccurrence(series: Series, start: number) {
  return expand({ ...series, exdates: [] }, start, start + 1).some((o) => o.start === start);
}

// ---------- Formato do Google ----------

/** Linhas "recurrence" do evento no Google: RRULE e as datas excluídas. */
export function toGoogleRecurrence(series: Series): string[] {
  const lines = [`RRULE:${series.recurrence}`];
  const ex = [...(series.exdates ?? [])].sort((a, b) => a - b);
  if (ex.length) {
    lines.push(
      series.allDay
        ? `EXDATE;VALUE=DATE:${ex.map((ms) => basic(toWall(ms, series.timezone)).slice(0, 8)).join(",")}`
        : `EXDATE;TZID=${series.timezone}:${ex.map((ms) => basic(toWall(ms, series.timezone))).join(",")}`,
    );
  }
  return lines;
}

/** Lê "recurrence" do Google. Só a primeira RRULE é usada; RDATE é ignorado. */
export function fromGoogleRecurrence(lines: string[], tz: string): { recurrence: string; exdates: number[] } | null {
  const rule = lines.find((l) => l.startsWith("RRULE:"));
  if (!rule) return null;
  const exdates: number[] = [];
  for (const line of lines.filter((l) => l.startsWith("EXDATE"))) {
    const [head, values] = line.split(/:(.*)/s);
    const zone = /TZID=([^;:]+)/.exec(head)?.[1] ?? tz;
    for (const v of values.split(",")) {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
      if (!m) continue;
      const iso = `${m[1]}-${m[2]}-${m[3]}${m[4] ? `T${m[4]}:${m[5]}:${m[6]}` : ""}`;
      const ms = m[7] ? Date.parse(`${iso}Z`) : parseDateTime(iso, zone);
      if (ms != null) exdates.push(ms);
    }
  }
  return { recurrence: rule.slice(6), exdates };
}
