import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, json, makeUser } from "./helpers";

const count = async (table: string) =>
  ((await env.DB.prepare(`select count(*) as n from ${table}`).first()) as { n: number }).n;

describe("validação", () => {
  it("rejeita payload inválido sem gravar nada", async () => {
    const u = await makeUser();
    const before = { tasks: await count("tasks"), audit: await count("audit_log") };

    const cases: unknown[] = [
      { title: "" },
      { title: "   " },
      { title: "x".repeat(201) },
      { title: "ok", status: "inexistente" },
      { title: "ok", campoDesconhecido: 1 },
      { title: "ok", dueAt: "2026-02-30T10:00" },
      { title: "ok", dueAt: "amanhã" },
      [],
    ];
    for (const body of cases) {
      const res = await call(u, "POST", "/api/tasks", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await json(res)).issues.length).toBeGreaterThan(0);
    }
    expect((await call(u, "POST", "/api/tasks", "{quebrado")).status).toBe(400);

    expect(await count("tasks")).toBe(before.tasks);
    expect(await count("audit_log")).toBe(before.audit);
  });

  it("rejeita compromisso com término antes do início", async () => {
    const u = await makeUser();
    const res = await call(u, "POST", "/api/events", { title: "x", startAt: "2026-10-01T10:00", endAt: "2026-10-01T09:00" });
    expect(res.status).toBe(400);
    expect((await json(res)).issues[0].path).toBe("endAt");
  });

  it("rejeita filtro com valor inválido", async () => {
    const u = await makeUser();
    expect((await call(u, "GET", "/api/tasks?status=xyz")).status).toBe(400);
    expect((await call(u, "GET", "/api/tasks?dueFrom=ontem")).status).toBe(400);
  });

  it("bloqueia mutação de outra origem ou sem JSON (CSRF)", async () => {
    const u = await makeUser();
    expect((await call(u, "POST", "/api/tasks", { title: "x" }, { origin: "https://malicioso.com" })).status).toBe(403);
    expect((await call(u, "POST", "/api/tasks", { title: "x" }, { origin: "https://app.test" })).status).toBe(201);
    const form = await call(u, "POST", "/api/tasks", "title=x", { "content-type": "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
  });
});

describe("papéis e auditoria", () => {
  it("membro não exclui; owner exclui e a auditoria guarda antes e depois", async () => {
    const owner = await makeUser();
    const member = await makeUser({ workspaceId: owner.workspaceId, role: "member" });
    const task = await json(await call(owner, "POST", "/api/tasks", { title: "Original", priority: "low" }));

    const patched = await call(member, "PATCH", `/api/tasks/${task.id}`, { title: "Novo", priority: "high" });
    expect(patched.status).toBe(200);
    expect((await call(member, "DELETE", `/api/tasks/${task.id}`)).status).toBe(403);
    expect((await call(owner, "DELETE", `/api/tasks/${task.id}`)).status).toBe(204);
    expect((await call(owner, "GET", `/api/tasks/${task.id}`)).status).toBe(404);

    const rows = (
      await env.DB.prepare("select action, user_id, before, after from audit_log where entity_id = ? order by created_at, rowid")
        .bind(task.id)
        .all()
    ).results as any[];
    expect(rows.map((r) => r.action)).toEqual(["create", "update", "delete"]);
    const update = rows[1];
    expect(update.user_id).toBe(member.id);
    expect(JSON.parse(update.before)).toEqual({ title: "Original", priority: "low" });
    expect(JSON.parse(update.after)).toEqual({ title: "Novo", priority: "high" });
    expect(JSON.parse(rows[2].before).title).toBe("Novo");
  });
});
