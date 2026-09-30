import { describe, expect, it } from "vitest";
import { call, json, makeUser } from "./helpers";

async function task(u: Awaited<ReturnType<typeof makeUser>>, title = "Pintar a sala") {
  return json(await call(u, "POST", "/api/tasks", { title }));
}

describe("checklist da tarefa", () => {
  it("adiciona, marca, renomeia, reordena e remove itens", async () => {
    const u = await makeUser();
    const t = await task(u);
    const base = `/api/tasks/${t.id}/checklist`;
    const a = await json(await call(u, "POST", base, { text: "Comprar tinta" }));
    const b = await json(await call(u, "POST", base, { text: "Lixar parede" }));
    const cRes = await call(u, "POST", base, { text: "Pintar" });
    expect(cRes.status).toBe(201);
    const c = await json(cRes);
    expect([a.position, b.position, c.position]).toEqual([0, 1, 2]);

    expect(await json(await call(u, "PATCH", `${base}/${a.id}`, { done: true }))).toMatchObject({ done: true, text: "Comprar tinta" });
    expect(await json(await call(u, "PATCH", `${base}/${b.id}`, { text: "Lixar e limpar a parede" }))).toMatchObject({ text: "Lixar e limpar a parede", done: false });

    const ordered = await json(await call(u, "PUT", `${base}/order`, { ids: [c.id, a.id, b.id] }));
    expect(ordered.map((i: any) => i.text)).toEqual(["Pintar", "Comprar tinta", "Lixar e limpar a parede"]);
    // A ordem precisa ter todos os itens, sem repetir.
    expect((await call(u, "PUT", `${base}/order`, { ids: [c.id, a.id] })).status).toBe(400);
    expect((await call(u, "PUT", `${base}/order`, { ids: [c.id, a.id, a.id] })).status).toBe(400);

    expect((await call(u, "DELETE", `${base}/${c.id}`)).status).toBe(204);
    expect((await json(await call(u, "GET", base))).map((i: any) => i.id)).toEqual([a.id, b.id]);

    // A lista de tarefas traz o progresso.
    const list = await json(await call(u, "GET", "/api/tasks"));
    expect(list.find((x: any) => x.id === t.id)).toMatchObject({ checklistTotal: 2, checklistDone: 1, commentCount: 0 });
  });

  it("valida o texto e isola por workspace", async () => {
    const u = await makeUser();
    const other = await makeUser();
    const t = await task(u);
    expect((await call(u, "POST", `/api/tasks/${t.id}/checklist`, { text: "   " })).status).toBe(400);
    expect((await call(u, "POST", `/api/tasks/${t.id}/checklist`, { text: "x", done: true })).status).toBe(400);
    const item = await json(await call(u, "POST", `/api/tasks/${t.id}/checklist`, { text: "Item" }));
    expect((await call(other, "GET", `/api/tasks/${t.id}/checklist`)).status).toBe(404);
    expect((await call(other, "PATCH", `/api/tasks/${t.id}/checklist/${item.id}`, { done: true })).status).toBe(404);
    // Item de outra tarefa não é alcançável pela rota desta.
    const t2 = await task(u, "Outra");
    expect((await call(u, "DELETE", `/api/tasks/${t2.id}/checklist/${item.id}`)).status).toBe(404);
  });

  it("some junto com a tarefa", async () => {
    const u = await makeUser();
    const t = await task(u);
    await call(u, "POST", `/api/tasks/${t.id}/checklist`, { text: "Item" });
    await call(u, "POST", `/api/tasks/${t.id}/comments`, { body: "Oi" });
    expect((await call(u, "DELETE", `/api/tasks/${t.id}`)).status).toBe(204);
    expect((await call(u, "GET", `/api/tasks/${t.id}/checklist`)).status).toBe(404);
  });
});

describe("comentários da tarefa", () => {
  it("mostra autor, edita só o próprio e apaga com permissão", async () => {
    const owner = await makeUser();
    const member = await makeUser({ workspaceId: owner.workspaceId, role: "member" });
    const t = await task(owner);
    const base = `/api/tasks/${t.id}/comments`;

    const c1 = await json(await call(member, "POST", base, { body: "Já comprei a tinta." }));
    expect(c1).toMatchObject({ body: "Já comprei a tinta.", userId: member.id, edited: false });
    expect(c1.authorName).toContain("@exemplo.com");
    const c2 = await json(await call(owner, "POST", base, { body: "Ótimo!" }));

    // O dono não edita o comentário de outra pessoa.
    expect((await call(owner, "PATCH", `${base}/${c1.id}`, { body: "mudado" })).status).toBe(403);
    const edited = await call(member, "PATCH", `${base}/${c1.id}`, { body: "Já comprei a tinta branca." });
    expect(await json(edited)).toMatchObject({ body: "Já comprei a tinta branca.", edited: true });

    // Membro não apaga o do dono; o dono apaga o do membro.
    expect((await call(member, "DELETE", `${base}/${c2.id}`)).status).toBe(403);
    expect((await call(owner, "DELETE", `${base}/${c1.id}`)).status).toBe(204);
    const left = await json(await call(member, "GET", base));
    expect(left.map((x: any) => x.body)).toEqual(["Ótimo!"]);
    expect((await call(member, "POST", base, { body: "" })).status).toBe(400);
  });
});

describe("histórico da tarefa", () => {
  it("junta mudanças da tarefa, da checklist e dos comentários, do mais novo para o mais antigo", async () => {
    const u = await makeUser();
    const t = await task(u);
    await call(u, "PATCH", `/api/tasks/${t.id}`, { status: "doing", priority: "high" });
    const item = await json(await call(u, "POST", `/api/tasks/${t.id}/checklist`, { text: "Comprar tinta" }));
    await call(u, "PATCH", `/api/tasks/${t.id}/checklist/${item.id}`, { done: true });
    await call(u, "POST", `/api/tasks/${t.id}/comments`, { body: "Feito" });

    const history = await json(await call(u, "GET", `/api/tasks/${t.id}/history`));
    expect(history.map((h: any) => `${h.entity}:${h.action}`)).toEqual(["task_comment:create", "task_item:update", "task_item:create", "task:update", "task:create"]);
    expect(history[1]).toMatchObject({ before: { done: false, text: "Comprar tinta" }, after: { done: true } });
    expect(history[3]).toMatchObject({ before: { status: "todo", priority: "medium" }, after: { status: "doing", priority: "high" } });
    expect(history[0].userName).toContain("@exemplo.com");
    expect(typeof history[0].createdAt).toBe("string");

    const other = await makeUser();
    expect((await call(other, "GET", `/api/tasks/${t.id}/history`)).status).toBe(404);
  });
});
