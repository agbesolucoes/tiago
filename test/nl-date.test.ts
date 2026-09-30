import { describe, expect, it } from "vitest";
import { addMinutes, parseWhen } from "../src/lib/nl-date";

const TZ = "America/Sao_Paulo";
// Quarta, 30/09/2026, 10:00 em São Paulo (13:00 UTC).
const NOW = Date.UTC(2026, 8, 30, 13, 0);
const p = (t: string) => parseWhen(t, NOW, TZ);

describe("parseWhen", () => {
  it("entende hoje, amanhã e depois de amanhã", () => {
    expect(p("dentista amanhã 14h")).toEqual({ title: "dentista", date: "2026-10-01", start: "14:00", end: null });
    expect(p("Reunião hoje às 16:30")).toEqual({ title: "Reunião", date: "2026-09-30", start: "16:30", end: null });
    expect(p("depois de amanhã 9h30 revisar contrato").date).toBe("2026-10-02");
  });

  it("entende dias da semana na próxima ocorrência", () => {
    expect(p("reunião com fornecedor sexta das 9h às 10h30")).toEqual({ title: "reunião com fornecedor", date: "2026-10-02", start: "09:00", end: "10:30" });
    expect(p("call na segunda-feira 15h").date).toBe("2026-10-05");
    // Mesmo dia da semana de hoje vai para a semana seguinte.
    expect(p("aula quarta 19h").date).toBe("2026-10-07");
    expect(p("feira no sábado").date).toBe("2026-10-03");
  });

  it("entende datas numéricas e dia do mês", () => {
    expect(p("consulta 12/10 às 8h")).toEqual({ title: "consulta", date: "2026-10-12", start: "08:00", end: null });
    expect(p("renovar seguro 15/01").date).toBe("2027-01-15");
    expect(p("pagar boleto dia 5").date).toBe("2026-10-05");
    expect(p("entregar dia 30/09/2026").date).toBe("2026-09-30");
    expect(p("data inválida 31/02").date).toBeNull();
  });

  it("entende intervalos e meio-dia", () => {
    expect(p("almoço amanhã meio-dia").start).toBe("12:00");
    expect(p("treino 7h-8h amanhã")).toMatchObject({ start: "07:00", end: "08:00", title: "treino" });
    expect(p("oficina amanhã de 14h até 17h")).toMatchObject({ start: "14:00", end: "17:00", title: "oficina" });
  });

  it("deixa em branco o que não foi dito", () => {
    expect(p("comprar tinta")).toEqual({ title: "comprar tinta", date: null, start: null, end: null });
    expect(p("ligar para o banco 25h")).toMatchObject({ start: null });
    expect(p("revisar 3 propostas").start).toBeNull();
  });

  it("soma minutos sem passar da meia-noite", () => {
    expect(addMinutes("14:30", 60)).toBe("15:30");
    expect(addMinutes("23:30", 60)).toBeNull();
  });
});
