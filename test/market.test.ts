import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { lenientJson, worldpopFetch } from "../src/integrations/worldpop";
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

describe("moradores por raio (WorldPop pelo servidor)", () => {
  const real = { ...worldpopFetch };
  afterEach(() => Object.assign(worldpopFetch, real));
  // Resposta real de outubro de 2026: avisos de PHP em HTML antes do JSON.
  const noisy = (body: object) => `<br />\n<b>Deprecated</b>:  Return type of Pimple\\Container::offsetExists($id) ...<br />\n${JSON.stringify(body, null, 4)}\n`;

  it("lê o JSON no meio dos avisos e acompanha a tarefa assíncrona", async () => {
    const urls: string[] = [];
    worldpopFetch.sleep = async () => {};
    worldpopFetch.impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/services/stats")) return new Response(noisy({ status: "created", taskid: "t1" }));
      return new Response(noisy({ status: "finished", data: { total_population: 151234.6 } }));
    }) as typeof fetch;
    const u = await makeUser();
    const res = await call(u, "GET", "/api/market-studies/population?lat=-23.56&lon=-46.65&r=2000");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ total: 151234.6, source: "WorldPop 2020" });
    expect(urls[0]).toContain("dataset=wpgppop");
    expect(urls[1]).toContain("/tasks/t1");
  });

  it("responde 502 com o motivo quando o WorldPop falha e 400 sem parâmetros", async () => {
    worldpopFetch.impl = (async () => new Response("<b>Fatal error</b>", { status: 200 })) as typeof fetch;
    const u = await makeUser();
    const res = await call(u, "GET", "/api/market-studies/population?lat=-23.56&lon=-46.65&r=2000");
    expect(res.status).toBe(502);
    expect((await json(res)).error).toContain("sem dados");
    expect((await call(u, "GET", "/api/market-studies/population?lat=-23.56")).status).toBe(400);
  });

  it("aceita lixo depois do JSON", () => {
    expect(lenientJson('{"a":{"b":1}}\n<br/>}')).toEqual({ a: { b: 1 } });
    expect(lenientJson('<br />\n<b>Deprecated</b>: x<br />\n{\n    "status": "started",\n    "data": {\n        "total_population": 251338.03\n    }\n}')).toEqual({ status: "started", data: { total_population: 251338.03 } });
    expect(lenientJson("<html>")).toBeNull();
  });
});
