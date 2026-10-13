import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, json, makeUser } from "./helpers";

const study = {
  address: "Avenida Paulista, 1578",
  city: "São Paulo - SP",
  lat: -23.5614,
  lon: -46.6559,
  verdict: "Renegociar",
  score: 3.3,
  coverage: 1,
  analyzedAt: "2026-10-08T16:00:00.000Z",
  stateGz: "H4sIAAAAAAAAA6tWKkktLlGyUlAqS8wpTVWqBQBvHo1jEQAAAA==",
};

describe("estudos de mercado", () => {
  it("guarda, lista sem o estado completo e reabre com ele", async () => {
    const u = await makeUser();
    const res = await call(u, "POST", "/api/market-studies", study);
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created).toMatchObject({ address: study.address, verdict: "Renegociar", analyzedAt: study.analyzedAt, hasState: true, projectId: null });
    expect(created.stateGz).toBeUndefined();

    const list = await json(await call(u, "GET", "/api/market-studies"));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, hasState: true });
    expect(list[0].stateGz).toBeUndefined();
    expect(await json(await call(u, "GET", "/api/market-studies?q=paulista"))).toHaveLength(1);
    expect(await json(await call(u, "GET", "/api/market-studies?q=bahia"))).toHaveLength(0);

    const full = await json(await call(u, "GET", `/api/market-studies/${created.id}`));
    expect(full.stateGz).toBe(study.stateGz);
  });

  it("valida os dados e recusa estado que não é base64", async () => {
    const u = await makeUser();
    expect((await call(u, "POST", "/api/market-studies", { ...study, address: " " })).status).toBe(400);
    expect((await call(u, "POST", "/api/market-studies", { ...study, score: 7 })).status).toBe(400);
    expect((await call(u, "POST", "/api/market-studies", { ...study, stateGz: "<script>" })).status).toBe(400);
    expect((await call(u, "POST", "/api/market-studies", { ...study, extra: 1 })).status).toBe(400);
  });

  it("cria um projeto a partir do estudo uma vez só", async () => {
    const u = await makeUser();
    const s = await json(await call(u, "POST", "/api/market-studies", study));
    const res = await call(u, "POST", `/api/market-studies/${s.id}/project`, { priority: "high" });
    expect(res.status).toBe(201);
    const project = await json(res);
    expect(project).toMatchObject({ title: "Ponto Omega: Avenida Paulista, 1578", priority: "high" });
    expect(project.description).toContain("Parecer: Renegociar");
    expect(project.description).toContain("Matriz: 3,3 / 5 (cobertura de 100% dos pesos)");

    expect((await call(u, "POST", `/api/market-studies/${s.id}/project`, {})).status).toBe(409);
    expect(await json(await call(u, "GET", "/api/projects"))).toHaveLength(1);
    const [listed] = await json(await call(u, "GET", "/api/market-studies"));
    expect(listed.projectId).toBe(project.id);

    // Apagar o projeto solta o estudo, que pode ganhar outro.
    expect((await call(u, "DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    const [after] = await json(await call(u, "GET", "/api/market-studies"));
    expect(after.projectId).toBeNull();
  });

  it("isola por workspace e só owner ou admin exclui", async () => {
    const owner = await makeUser();
    const member = await makeUser({ workspaceId: owner.workspaceId, role: "member" });
    const other = await makeUser();
    const s = await json(await call(member, "POST", "/api/market-studies", study));
    expect((await call(other, "GET", `/api/market-studies/${s.id}`)).status).toBe(404);
    expect(await json(await call(other, "GET", "/api/market-studies"))).toHaveLength(0);
    expect((await call(member, "DELETE", `/api/market-studies/${s.id}`)).status).toBe(403);
    expect((await call(owner, "DELETE", `/api/market-studies/${s.id}`)).status).toBe(204);
    const audit = (await env.DB.prepare("select action from audit_log where entity_id = ? order by created_at").bind(s.id).all()).results;
    expect(audit.map((r: any) => r.action)).toEqual(["create", "delete"]);
  });
});
