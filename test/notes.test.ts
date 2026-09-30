import { describe, expect, it } from "vitest";
import { call, json, makeUser } from "./helpers";

async function meeting(u: Awaited<ReturnType<typeof makeUser>>, projectId?: string) {
  return json(await call(u, "POST", "/api/events", { title: "Reunião com arquiteto", startAt: "2026-10-05T14:00", endAt: "2026-10-05T15:00", projectId }));
}

describe("registro de reunião", () => {
  it("salva pauta, resumo e decisões; editar mantém os ids", async () => {
    const u = await makeUser();
    const ev = await meeting(u);
    expect(await json(await call(u, "GET", `/api/events/${ev.id}/notes`))).toMatchObject({ agenda: null, decisions: [] });

    const saved = await json(await call(u, "PUT", `/api/events/${ev.id}/notes`, { agenda: "1. Planta\n2. Prazos", summary: "Planta aprovada.", decisions: [{ text: "Contratar eletricista" }, { text: "Comprar piso" }] }));
    expect(saved.decisions.map((d: any) => d.text)).toEqual(["Contratar eletricista", "Comprar piso"]);
    const [d1, d2] = saved.decisions;

    const edited = await json(await call(u, "PUT", `/api/events/${ev.id}/notes`, { decisions: [{ id: d2.id, text: "Comprar piso cerâmico" }, { id: d1.id, text: d1.text }] }));
    expect(edited.agenda).toBe("1. Planta\n2. Prazos");
    expect(edited.decisions.map((d: any) => d.id)).toEqual([d2.id, d1.id]);
  });

  it("decisão vira tarefa ligada ao compromisso e ao projeto, uma vez só", async () => {
    const u = await makeUser();
    const project = await json(await call(u, "POST", "/api/projects", { title: "Reforma" }));
    const ev = await meeting(u, project.id);
    const notes = await json(await call(u, "PUT", `/api/events/${ev.id}/notes`, { decisions: [{ text: "Contratar eletricista" }] }));
    const decision = notes.decisions[0];

    const res = await call(u, "POST", `/api/events/${ev.id}/notes/decisions/${decision.id}/task`, { priority: "high", dueAt: "2026-10-10" });
    expect(res.status).toBe(201);
    const { task, notes: after } = await json(res);
    expect(task).toMatchObject({ title: "Contratar eletricista", sourceEventId: ev.id, projectId: project.id, priority: "high" });
    expect(task.description).toContain("05/10/2026 às 14:00");
    expect(after.decisions[0].taskId).toBe(task.id);

    expect((await call(u, "POST", `/api/events/${ev.id}/notes/decisions/${decision.id}/task`, {})).status).toBe(409);
    // Salvar o registro de novo não perde o vínculo.
    const resaved = await json(await call(u, "PUT", `/api/events/${ev.id}/notes`, { decisions: [{ id: decision.id, text: "Contratar eletricista até sexta" }] }));
    expect(resaved.decisions[0].taskId).toBe(task.id);
    // O cliente não consegue forjar o vínculo.
    expect((await call(u, "PUT", `/api/events/${ev.id}/notes`, { decisions: [{ text: "x", taskId: "falso" }] })).status).toBe(400);
  });

  it("valida e isola por workspace", async () => {
    const u = await makeUser();
    const other = await makeUser();
    const ev = await meeting(u);
    expect((await call(u, "PUT", `/api/events/${ev.id}/notes`, { decisions: [{ text: "  " }] })).status).toBe(400);
    expect((await call(other, "GET", `/api/events/${ev.id}/notes`)).status).toBe(404);
    expect((await call(other, "PUT", `/api/events/${ev.id}/notes`, { summary: "x" })).status).toBe(404);
  });
});
