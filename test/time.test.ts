import { describe, expect, it } from "vitest";
import { localDayRange, parseDateTime } from "../src/lib/time";
import { call, json, makeUser } from "./helpers";

const SP = "America/Sao_Paulo";

describe("fuso horário", () => {
  it("interpreta hora local em São Paulo e grava em UTC", () => {
    expect(new Date(parseDateTime("2026-10-01T09:00", SP)!).toISOString()).toBe("2026-10-01T12:00:00.000Z");
    // 23:30 em São Paulo já é o dia seguinte em UTC.
    expect(new Date(parseDateTime("2026-10-01T23:30", SP)!).toISOString()).toBe("2026-10-02T02:30:00.000Z");
    expect(new Date(parseDateTime("2026-10-01", SP)!).toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });

  it("respeita offset explícito", () => {
    expect(parseDateTime("2026-10-01T09:00:00Z", SP)).toBe(Date.parse("2026-10-01T09:00:00Z"));
    expect(parseDateTime("2026-10-01T09:00:00-03:00", SP)).toBe(Date.parse("2026-10-01T12:00:00Z"));
  });

  it("rejeita datas impossíveis", () => {
    expect(parseDateTime("2026-02-30T10:00", SP)).toBeNull();
    expect(parseDateTime("2026-10-01T25:00", SP)).toBeNull();
    expect(parseDateTime("01/10/2026", SP)).toBeNull();
  });

  it("calcula o dia local", () => {
    const [start, end] = localDayRange(Date.parse("2026-10-02T02:30:00Z"), SP);
    expect(new Date(start).toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-10-02T03:00:00.000Z");
  });

  it("horário salvo volta igual e o filtro por dia usa o dia local", async () => {
    const u = await makeUser();
    const t = await json(await call(u, "POST", "/api/tasks", { title: "Noite", dueAt: "2026-10-01T23:30" }));
    expect(t.dueAt).toBe("2026-10-02T02:30:00.000Z");
    await call(u, "POST", "/api/tasks", { title: "Outro dia", dueAt: "2026-10-02T08:00" });
    const day = await json(await call(u, "GET", "/api/tasks?dueFrom=2026-10-01&dueTo=2026-10-02"));
    expect(day.map((x: any) => x.title)).toEqual(["Noite"]);
  });
});

describe("compromissos", () => {
  it("aponta conflitos com compromissos sobrepostos, mas não com os encostados", async () => {
    const u = await makeUser();
    const first = await json(await call(u, "POST", "/api/events", { title: "Dentista", startAt: "2026-10-05T14:00", endAt: "2026-10-05T15:00" }));
    expect(first.conflicts).toEqual([]);
    const overlap = await json(await call(u, "POST", "/api/events", { title: "Reunião", startAt: "2026-10-05T14:30", endAt: "2026-10-05T16:00" }));
    expect(overlap.conflicts.map((e: any) => e.id)).toEqual([first.id]);
    const adjacent = await json(await call(u, "POST", "/api/events", { title: "Café", startAt: "2026-10-05T16:00", endAt: "2026-10-05T16:30" }));
    expect(adjacent.conflicts).toEqual([]);

    const moved = await json(await call(u, "PATCH", `/api/events/${adjacent.id}`, { startAt: "2026-10-05T14:45" }));
    expect(moved.conflicts.map((e: any) => e.title).sort()).toEqual(["Dentista", "Reunião"]);

    const range = await json(await call(u, "GET", "/api/events?from=2026-10-05T15:30&to=2026-10-05T17:00"));
    expect(range.map((e: any) => e.title)).toEqual(["Reunião", "Café"]);
  });

  it("painel conta tarefas atrasadas e compromissos de hoje", async () => {
    const u = await makeUser();
    await call(u, "POST", "/api/tasks", { title: "Atrasada", dueAt: "2020-01-01T10:00" });
    await call(u, "POST", "/api/tasks", { title: "Feita", status: "done", dueAt: "2020-01-01T10:00" });
    await call(u, "POST", "/api/ideas", { title: "Nova" });
    const d = await json(await call(u, "GET", "/api/dashboard"));
    expect(d.overdueTasks).toBe(1);
    expect(d.tasksByStatus).toEqual({ todo: 1, done: 1 });
    expect(d.newIdeas).toBe(1);
  });
});
