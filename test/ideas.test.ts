import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, json, makeUser } from "./helpers";

describe("ideias", () => {
  it("converte em tarefa preservando a origem e bloqueia conversão dupla", async () => {
    const u = await makeUser();
    const project = await json(await call(u, "POST", "/api/projects", { title: "Casa" }));
    const idea = await json(
      await call(u, "POST", "/api/ideas", { title: "Pintar a sala", description: "cor clara", category: "casa", origin: "Telegram", tags: ["Reforma", "reforma", "urgente"] }),
    );
    expect(idea.tags).toEqual(["reforma", "urgente"]);

    const res = await call(u, "POST", `/api/ideas/${idea.id}/convert`, { to: "task", projectId: project.id, priority: "high" });
    expect(res.status).toBe(201);
    const { kind, record } = await json(res);
    expect(kind).toBe("task");
    expect(record).toMatchObject({ title: "Pintar a sala", description: "cor clara", sourceIdeaId: idea.id, projectId: project.id, priority: "high" });

    const after = await json(await call(u, "GET", `/api/ideas/${idea.id}`));
    expect(after).toMatchObject({ status: "converted", convertedToKind: "task", convertedToId: record.id, origin: "Telegram" });

    expect((await call(u, "POST", `/api/ideas/${idea.id}/convert`, { to: "project" })).status).toBe(409);
    expect(await json(await call(u, "GET", "/api/tasks"))).toHaveLength(1);

    const audit = (await env.DB.prepare("select action from audit_log where entity_id = ?").bind(idea.id).all()).results;
    expect(audit.map((r: any) => r.action)).toEqual(["create", "convert"]);
  });

  it("converte em projeto", async () => {
    const u = await makeUser();
    const idea = await json(await call(u, "POST", "/api/ideas", { title: "App de receitas" }));
    const { kind, record } = await json(await call(u, "POST", `/api/ideas/${idea.id}/convert`, { to: "project" }));
    expect(kind).toBe("project");
    expect(record.sourceIdeaId).toBe(idea.id);
  });

  it("não permite marcar como convertida sem converter", async () => {
    const u = await makeUser();
    const idea = await json(await call(u, "POST", "/api/ideas", { title: "x" }));
    expect((await call(u, "PATCH", `/api/ideas/${idea.id}`, { status: "converted" })).status).toBe(400);
  });

  it("filtra por status e troca etiquetas", async () => {
    const u = await makeUser();
    const a = await json(await call(u, "POST", "/api/ideas", { title: "A", tags: ["x"] }));
    await call(u, "POST", "/api/ideas", { title: "B", status: "approved" });
    const approved = await json(await call(u, "GET", "/api/ideas?status=approved"));
    expect(approved.map((i: any) => i.title)).toEqual(["B"]);
    const updated = await json(await call(u, "PATCH", `/api/ideas/${a.id}`, { tags: ["y", "z"] }));
    expect(updated.tags).toEqual(["y", "z"]);
  });
});
