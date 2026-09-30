import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachments, integrationAccounts } from "../src/db/schema";
import { googleFetch } from "../src/integrations/google-client";
import { newId } from "../src/lib/crypto";
import { encryptSecret } from "../src/lib/secret";
import { FakeGoogle } from "./fake-google";
import { call, db, json, makeUser, type TestUser } from "./helpers";

const DRIVE = "https://www.googleapis.com/auth/drive.file";
let g: FakeGoogle;
const realFetch = googleFetch.impl;
beforeEach(() => {
  g = new FakeGoogle();
  googleFetch.impl = g.fetch;
});
afterEach(() => {
  googleFetch.impl = realFetch;
});

async function connect(user: TestUser, scopes = `openid email ${DRIVE}`) {
  await db()
    .insert(integrationAccounts)
    .values({
      id: newId(),
      workspaceId: user.workspaceId,
      userId: user.id,
      provider: "google",
      externalSub: "g-1",
      email: "dono@gmail.com",
      scopes,
      refreshTokenEnc: await encryptSecret("rt", env.TOKEN_ENCRYPTION_KEY),
    });
}

function upload(u: TestUser, query: string, content: string, type = "text/plain") {
  return call(u, "POST", `/api/attachments/upload?${query}`, content, { "content-type": type, "x-central-upload": "1" });
}

describe("pastas no Drive", () => {
  it("cria a estrutura uma vez, reutiliza e recria se a pasta for apagada", async () => {
    const u = await makeUser();
    await connect(u);
    const first = await json(await call(u, "POST", "/api/attachments/folders", {}));
    const names = [...g.files.values()].map((f) => f.name).sort();
    expect(names).toEqual(["Central de Organização", "Compromissos", "Documentos gerais", "Ideias", "Projetos"]);
    expect(first.rootUrl).toBe(`https://drive.google.com/drive/folders/${first.folders.root}`);

    await call(u, "POST", "/api/attachments/folders", {});
    expect(g.files.size).toBe(5);

    g.files.get(first.folders.root)!.trashed = true;
    const again = await json(await call(u, "POST", "/api/attachments/folders", {}));
    expect(again.folders.root).not.toBe(first.folders.root);
    expect(g.calls.some((c) => c.path.includes("permissions"))).toBe(false);
  });
});

describe("anexos", () => {
  it("envia em streaming para a pasta certa e só grava o vínculo depois do Google", async () => {
    const u = await makeUser();
    await connect(u);
    const project = await json(await call(u, "POST", "/api/projects", { title: "Casa" }));
    const task = await json(await call(u, "POST", "/api/tasks", { title: "Orçamento", projectId: project.id }));

    const res = await upload(u, `parentKind=task&parentId=${task.id}&name=orcamento.txt`, "conteúdo do orçamento");
    expect(res.status).toBe(201);
    const att = await json(res);
    expect(att).toMatchObject({ name: "orcamento.txt", mimeType: "text/plain", origin: "uploaded", parentKind: "task", parentId: task.id });
    expect(att.webViewLink).toContain("drive.google.com");

    const stored = g.files.get(att.driveFileId)!;
    expect(stored.content).toBe("conteúdo do orçamento");
    const folders = (await db().query.integrationAccounts.findFirst({ where: eq(integrationAccounts.workspaceId, u.workspaceId) }))!.driveFolders!;
    expect(stored.parents).toEqual([folders.project]); // tarefa com projeto vai para "Projetos"

    const list = await json(await call(u, "GET", `/api/attachments?parentKind=task&parentId=${task.id}`));
    expect(list.map((a: any) => a.id)).toEqual([att.id]);

    const general = await json(await upload(u, "parentKind=general&name=contrato.txt", "x"));
    expect(g.files.get(general.driveFileId)!.parents).toEqual([folders.general]);
  });

  it("falha do Drive não grava vínculo", async () => {
    const u = await makeUser();
    await connect(u);
    await call(u, "POST", "/api/attachments/folders", {});
    g.failNext.set("PUT drive", 503);
    const res = await upload(u, "parentKind=general&name=a.txt", "abc");
    expect(res.status).toBe(502);
    expect(await db().select().from(attachments).where(eq(attachments.workspaceId, u.workspaceId))).toHaveLength(0);
  });

  it("valida o pedido e protege contra envio de outro site", async () => {
    const u = await makeUser();
    await connect(u);
    const other = await makeUser();
    const foreign = await json(await call(other, "POST", "/api/tasks", { title: "Alheia" }));
    expect((await upload(u, `parentKind=task&parentId=${foreign.id}&name=a.txt`, "x")).status).toBe(400);
    expect((await upload(u, "parentKind=task&name=a.txt", "x")).status).toBe(400);
    expect((await upload(u, "parentKind=xyz&name=a.txt", "x")).status).toBe(400);
    expect((await upload(u, "parentKind=general", "x")).status).toBe(400);
    // Sem o cabeçalho próprio, só JSON é aceito.
    expect((await call(u, "POST", "/api/attachments/upload?parentKind=general&name=a.txt", "x", { "content-type": "text/plain" })).status).toBe(415);
    expect((await upload(u, "parentKind=general&name=a.txt", "x", "text/plain")).status).toBe(201);
  });

  it("sem Drive autorizado pede reconexão", async () => {
    const u = await makeUser();
    await connect(u, "openid email calendar");
    const res = await upload(u, "parentKind=general&name=a.txt", "x");
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(/Drive/);
    const semConta = await makeUser();
    expect((await upload(semConta, "parentKind=general&name=a.txt", "x")).status).toBe(409);
  });

  it("vincula arquivo escolhido no Picker e recusa arquivo sem acesso", async () => {
    const u = await makeUser();
    await connect(u);
    const idea = await json(await call(u, "POST", "/api/ideas", { title: "Painel solar" }));
    const picked = g.addUserFile("orcamento-solar.pdf");
    const hidden = g.addUserFile("particular.pdf");
    g.pickedIds.add(picked);

    const res = await call(u, "POST", "/api/attachments/link", { parentKind: "idea", parentId: idea.id, driveFileId: picked });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ name: "orcamento-solar.pdf", origin: "linked" });
    // Repetir não duplica.
    await call(u, "POST", "/api/attachments/link", { parentKind: "idea", parentId: idea.id, driveFileId: picked });
    expect(await json(await call(u, "GET", `/api/attachments?parentKind=idea&parentId=${idea.id}`))).toHaveLength(1);

    const denied = await call(u, "POST", "/api/attachments/link", { parentKind: "idea", parentId: idea.id, driveFileId: hidden });
    expect(denied.status).toBe(400);
    expect(g.calls.some((c) => c.path.includes("permissions"))).toBe(false);
  });

  it("remover só desfaz o vínculo; excluir o registro limpa os vínculos", async () => {
    const u = await makeUser();
    await connect(u);
    const task = await json(await call(u, "POST", "/api/tasks", { title: "Com anexo" }));
    const a = await json(await upload(u, `parentKind=task&parentId=${task.id}&name=a.txt`, "x"));
    expect((await call(u, "DELETE", `/api/attachments/${a.id}`)).status).toBe(204);
    expect(g.files.get(a.driveFileId)!.trashed).toBe(false);

    await upload(u, `parentKind=task&parentId=${task.id}&name=b.txt`, "y");
    await call(u, "DELETE", `/api/tasks/${task.id}`);
    expect(await db().select().from(attachments).where(eq(attachments.parentId, task.id))).toHaveLength(0);
  });

  it("outro workspace não vê nem remove anexos", async () => {
    const u = await makeUser();
    await connect(u);
    const a = await json(await upload(u, "parentKind=general&name=a.txt", "x"));
    const other = await makeUser();
    expect(await json(await call(other, "GET", "/api/attachments?parentKind=general"))).toEqual([]);
    expect((await call(other, "DELETE", `/api/attachments/${a.id}`)).status).toBe(404);
  });
});

describe("status do Drive", () => {
  it("mostra se o Drive está autorizado e o seletor configurado", async () => {
    const u = await makeUser();
    await connect(u);
    await call(u, "POST", "/api/attachments/folders", {});
    const s = await json(await call(u, "GET", "/api/integrations/google"));
    expect(s.driveEnabled).toBe(true);
    expect(s.driveFolderUrl).toMatch(/^https:\/\/drive.google.com\/drive\/folders\//);
    expect(s.pickerEnabled).toBe(false);
    expect((await call(u, "GET", "/api/integrations/google/picker")).status).toBe(409);
  });
});
