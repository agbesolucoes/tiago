import { describe, expect, it } from "vitest";
import { call, json, makeUser } from "./helpers";

describe("isolamento entre workspaces", () => {
  it("usuário B não vê nem altera nada do workspace de A", async () => {
    const a = await makeUser();
    const b = await makeUser();

    const project = await json(await call(a, "POST", "/api/projects", { title: "Projeto secreto" }));
    const task = await json(await call(a, "POST", "/api/tasks", { title: "Tarefa secreta", projectId: project.id }));
    const idea = await json(await call(a, "POST", "/api/ideas", { title: "Ideia secreta" }));
    const event = await json(
      await call(a, "POST", "/api/events", { title: "Reunião secreta", startAt: "2026-10-01T09:00", endAt: "2026-10-01T10:00" }),
    );

    for (const path of ["/api/projects", "/api/tasks", "/api/ideas", "/api/events"]) {
      expect(await json(await call(b, "GET", path))).toEqual([]);
    }
    const search = await json(await call(b, "GET", "/api/search?q=secret"));
    expect(search).toEqual({ tasks: [], projects: [], ideas: [], events: [] });

    const items: [string, string][] = [
      ["projects", project.id],
      ["tasks", task.id],
      ["ideas", idea.id],
      ["events", event.id],
    ];
    for (const [kind, id] of items) {
      expect((await call(b, "GET", `/api/${kind}/${id}`)).status).toBe(404);
      expect((await call(b, "PATCH", `/api/${kind}/${id}`, { title: "invadido" })).status).toBe(404);
      expect((await call(b, "DELETE", `/api/${kind}/${id}`)).status).toBe(404);
    }
    expect((await call(b, "POST", `/api/ideas/${idea.id}/convert`, { to: "task" })).status).toBe(404);

    // Nada mudou para A.
    expect((await json(await call(a, "GET", `/api/tasks/${task.id}`))).title).toBe("Tarefa secreta");
    expect(await json(await call(a, "GET", "/api/projects"))).toHaveLength(1);
  });

  it("não aceita referência a registro de outro workspace", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const project = await json(await call(a, "POST", "/api/projects", { title: "De A" }));
    const event = await json(await call(a, "POST", "/api/events", { title: "De A", startAt: "2026-10-01T09:00", endAt: "2026-10-01T10:00" }));

    const res = await call(b, "POST", "/api/tasks", { title: "x", projectId: project.id });
    expect(res.status).toBe(400);
    expect((await json(res)).issues[0].path).toBe("projectId");
    expect((await call(b, "POST", "/api/tasks", { title: "x", sourceEventId: event.id })).status).toBe(400);
    expect((await call(b, "POST", "/api/tasks", { title: "x", assigneeId: a.id })).status).toBe(400);
    expect((await call(b, "POST", "/api/events", { title: "x", startAt: "2026-10-01T09:00", endAt: "2026-10-01T10:00", projectId: project.id })).status).toBe(400);
    expect(await json(await call(b, "GET", "/api/tasks"))).toEqual([]);
  });

  it("não deixa escolher workspace alheio pelo cabeçalho", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await call(a, "POST", "/api/projects", { title: "De A" });
    const res = await call(b, "GET", "/api/projects", undefined, { "x-workspace-id": a.workspaceId });
    expect(res.status).toBe(404);
  });

  it("dois membros do mesmo workspace compartilham os registros", async () => {
    const owner = await makeUser();
    const member = await makeUser({ workspaceId: owner.workspaceId, role: "member" });
    const task = await json(await call(owner, "POST", "/api/tasks", { title: "Compartilhada", assigneeId: member.id }));
    const list = await json(await call(member, "GET", `/api/tasks?assigneeId=${member.id}`));
    expect(list.map((t: any) => t.id)).toEqual([task.id]);
  });

  it("sem sessão ou com sessão inválida retorna 401", async () => {
    expect((await call(null, "GET", "/api/tasks")).status).toBe(401);
    expect((await call({ id: "x", workspaceId: "x", cookie: "sid=falso" }, "GET", "/api/tasks")).status).toBe(401);
  });
});
