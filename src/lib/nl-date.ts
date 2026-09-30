// Interpreta datas e horas escritas em português ("amanhã 14h", "sexta das 9h às 10h30",
// "12/10") no fuso do workspace. Devolve o título sem os trechos de data.

export interface When {
  title: string;
  date: string | null; // AAAA-MM-DD no fuso local
  start: string | null; // HH:mm
  end: string | null; // HH:mm
}

const WEEKDAYS: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };

// \b do JavaScript não trata letras acentuadas como letras; estas bordas tratam.
const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}/])`;
const re = (src: string) => new RegExp(src, "iu");

const TIME = String.raw`(\d{1,2})(?:(?::|h)(\d{2})|h)`;
const RANGE_RE = re(String.raw`(?:${L}d[ae]s?\s+)?${TIME}\s*(?:-|–|${L}(?:às|as|até|a)${R})\s*${TIME}${R}`);
const SINGLE_RE = re(String.raw`(?:${L}(?:às|as|à|a partir das)\s+)?${TIME}${R}`);
const NOON_RE = re(String.raw`${L}(?:ao\s+)?meio[- ]dia${R}`);
const REL_RE = re(String.raw`${L}(depois de amanh[ãa]|amanh[ãa]|hoje)${R}`);
const WEEKDAY_RE = re(String.raw`${L}(?:(?:na|no|nesta|neste|esta|este|próxim[ao]|proxim[ao])\s+)?(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?(?:\s+que\s+vem)?${R}`);
const DMY_RE = re(String.raw`(?:${L}(?:no\s+)?dia\s+)?${L}(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?${R}`);
const DAY_RE = re(String.raw`${L}(?:no\s+)?dia\s+(\d{1,2})${R}`);

const pad = (n: number) => String(n).padStart(2, "0");
const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function localToday(nowMs: number, timeZone: string) {
  const [y, m, d] = new Date(nowMs).toLocaleDateString("en-CA", { timeZone }).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

function validDate(y: number, m: number, d: number) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

function hhmm(h: string, m: string | undefined) {
  const hour = Number(h);
  const min = Number(m ?? 0);
  return hour <= 23 && min <= 59 ? `${pad(hour)}:${pad(min)}` : null;
}

export function parseWhen(text: string, nowMs: number, timeZone: string): When {
  let rest = ` ${text.trim()} `;
  const cut = (m: RegExpExecArray) => {
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
  };
  const today = localToday(nowMs, timeZone);
  let date: Date | null = null;
  let start: string | null = null;
  let end: string | null = null;

  // Datas primeiro: "12/10" não pode ser lido como hora.
  let m: RegExpExecArray | null;
  if ((m = DMY_RE.exec(rest))) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), m[3]];
    const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : today.getUTCFullYear();
    date = validDate(year, mo, d);
    if (date && !y && date < today) date = validDate(year + 1, mo, d);
    if (date) cut(m);
  } else if ((m = REL_RE.exec(rest))) {
    const word = strip(m[1]);
    date = addDays(today, word === "hoje" ? 0 : word === "amanha" ? 1 : 2);
    cut(m);
  } else if ((m = WEEKDAY_RE.exec(rest))) {
    const target = WEEKDAYS[strip(m[1])];
    const diff = (target - today.getUTCDay() + 7) % 7 || 7;
    date = addDays(today, diff);
    cut(m);
  } else if ((m = DAY_RE.exec(rest))) {
    const d = Number(m[1]);
    let y = today.getUTCFullYear();
    let mo = today.getUTCMonth() + 1;
    if (d < today.getUTCDate()) mo === 12 ? ((mo = 1), y++) : mo++;
    date = validDate(y, mo, d);
    if (date) cut(m);
  }

  if ((m = RANGE_RE.exec(rest))) {
    start = hhmm(m[1], m[2]);
    end = hhmm(m[3], m[4]);
    if (start && end) cut(m);
    else start = end = null;
  }
  if (!start && (m = SINGLE_RE.exec(rest))) {
    start = hhmm(m[1], m[2]);
    if (start) cut(m);
  }
  if (!start && (m = NOON_RE.exec(rest))) {
    start = "12:00";
    cut(m);
  }

  const title = rest
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:no|na|em|de|dia|às|as|para|pra)\s+)+/iu, "")
    .replace(/(?:\s+(?:no|na|em|de|dia|às|as|para|pra|,|-))+$/iu, "")
    .replace(/[\s,;-]+$/, "")
    .trim();
  return { title, date: date ? iso(date) : null, start, end };
}

/** Soma minutos a "HH:mm" na mesma data; devolve null se passar da meia-noite. */
export function addMinutes(time: string, minutes: number) {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return total >= 24 * 60 ? null : `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
