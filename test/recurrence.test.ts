import { describe, expect, it } from "vitest";
import { expand, fromGoogleRecurrence, fromRRule, isOccurrence, seriesEnd, toGoogleRecurrence, toRRule } from "../src/lib/recurrence";
import { parseDateTime } from "../src/lib/time";

const TZ = "America/Sao_Paulo";
const at = (s: string, tz = TZ) => parseDateTime(s, tz)!;
const iso = (ms: number) => new Date(ms).toISOString();

describe("regras", () => {
  it("monta e lê a regra da tela", () => {
    const start = at("2026-09-30T09:00"); // quarta
    expect(toRRule({ freq: "weekly", interval: 1 }, start, TZ, false)).toBe("FREQ=WEEKLY;BYDAY=WE");
    expect(toRRule({ freq: "weekly", interval: 2, byDay: ["FR", "MO"] }, start, TZ, false)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
    const until = toRRule({ freq: "daily", interval: 1, until: "2026-10-05" }, start, TZ, false);
    expect(until).toBe("FREQ=DAILY;UNTIL=20261006T025959Z");
    expect(fromRRule(until, TZ)).toEqual({ freq: "daily", interval: 1, until: "2026-10-05" });
    expect(toRRule({ freq: "monthly", interval: 1, count: 6 }, start, TZ, true)).toBe("FREQ=MONTHLY;COUNT=6");
    expect(fromRRule("FREQ=MONTHLY;BYDAY=2MO", TZ)).toBeNull();
    expect(fromRRule("FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=2", TZ)).toEqual({ freq: "weekly", interval: 2, byDay: ["MO", "TH"] });
  });
});

describe("expansão", () => {
  const weekly = { startAt: at("2026-09-30T09:00"), endAt: at("2026-09-30T10:00"), timezone: TZ, allDay: false, recurrence: "FREQ=WEEKLY;BYDAY=MO,WE" };

  it("gera as ocorrências do intervalo", () => {
    const occ = expand(weekly, at("2026-10-01T00:00"), at("2026-10-15T00:00"));
    expect(occ.map((o) => iso(o.start))).toEqual(["2026-10-05T12:00:00.000Z", "2026-10-07T12:00:00.000Z", "2026-10-12T12:00:00.000Z", "2026-10-14T12:00:00.000Z"]);
    expect(occ[0].end - occ[0].start).toBe(3_600_000);
  });

  it("pula datas excluídas e as substituídas", () => {
    const occ = expand({ ...weekly, exdates: [at("2026-10-05T09:00")] }, at("2026-10-01T00:00"), at("2026-10-10T00:00"), new Set([at("2026-10-07T09:00")]));
    expect(occ).toEqual([]);
  });

  it("mantém a hora local quando o fuso muda de offset", () => {
    const ny = { startAt: at("2026-10-26T09:00", "America/New_York"), endAt: at("2026-10-26T10:00", "America/New_York"), timezone: "America/New_York", allDay: false, recurrence: "FREQ=WEEKLY" };
    const occ = expand(ny, at("2026-10-26T00:00", "America/New_York"), at("2026-11-10T00:00", "America/New_York"));
    // 26/10 ainda em horário de verão (UTC-4); 2/11 e 9/11 já em UTC-5.
    expect(occ.map((o) => iso(o.start))).toEqual(["2026-10-26T13:00:00.000Z", "2026-11-02T14:00:00.000Z", "2026-11-09T14:00:00.000Z"]);
  });

  it("respeita COUNT e UNTIL e calcula o fim da série", () => {
    const daily = { ...weekly, recurrence: "FREQ=DAILY;COUNT=3" };
    expect(expand(daily, at("2026-09-01T00:00"), at("2026-12-01T00:00"))).toHaveLength(3);
    expect(iso(seriesEnd(daily)!)).toBe("2026-10-02T13:00:00.000Z");
    const until = { ...weekly, recurrence: "FREQ=DAILY;UNTIL=20261002T025959Z" };
    expect(expand(until, at("2026-09-01T00:00"), at("2026-12-01T00:00")).map((o) => iso(o.start))).toEqual(["2026-09-30T12:00:00.000Z", "2026-10-01T12:00:00.000Z"]);
    expect(seriesEnd(weekly)).toBeNull();
  });

  it("dia inteiro e mensal", () => {
    const bday = { startAt: at("2026-01-31"), endAt: at("2026-02-01"), timezone: TZ, allDay: true, recurrence: "FREQ=MONTHLY" };
    // Meses sem dia 31 são pulados, como no Google.
    expect(expand(bday, at("2026-02-01"), at("2026-06-01")).map((o) => iso(o.start))).toEqual(["2026-03-31T03:00:00.000Z", "2026-05-31T03:00:00.000Z"]);
    expect(isOccurrence(bday, at("2026-03-31"))).toBe(true);
    expect(isOccurrence(bday, at("2026-04-30"))).toBe(false);
  });
});

describe("formato do Google", () => {
  it("ida e volta com datas excluídas", () => {
    const series = { startAt: at("2026-09-30T09:00"), endAt: at("2026-09-30T10:00"), timezone: TZ, allDay: false, recurrence: "FREQ=WEEKLY", exdates: [at("2026-10-07T09:00")] };
    const lines = toGoogleRecurrence(series);
    expect(lines).toEqual(["RRULE:FREQ=WEEKLY", "EXDATE;TZID=America/Sao_Paulo:20261007T090000"]);
    expect(fromGoogleRecurrence(lines, TZ)).toEqual({ recurrence: "FREQ=WEEKLY", exdates: [at("2026-10-07T09:00")] });
    expect(fromGoogleRecurrence(["RRULE:FREQ=DAILY", "EXDATE:20261001T120000Z", "EXDATE;VALUE=DATE:20261003"], TZ)!.exdates).toEqual([Date.parse("2026-10-01T12:00:00Z"), at("2026-10-03")]);
  });
});
