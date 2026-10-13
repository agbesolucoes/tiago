import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingConfirmations, secretaryDrafts, taskItems, tasks } from "../src/db/schema";
import { secretaryAi, SecretaryError, type ProposalOutput, type SecretaryContext, type SecretaryInput } from "../src/integrations/secretary";
import { createLinkCode, handleUpdate } from "../src/integrations/telegram-bot";
import { telegramFetch, type TgUpdate } from "../src/integrations/telegram-client";
import { assemblyFetch, formatTranscript, resumeTranscriptions } from "../src/integrations/transcription";
import { docxToText } from "../src/lib/docx";
import { call, db, json, makeUser, type TestUser } from "./helpers";

// ---------- Resposta pronta no lugar do Claude ----------

let seen: { input: SecretaryInput; context: SecretaryContext }[] = [];
let answer: (ctx: SecretaryContext) => ProposalOutput | Promise<ProposalOutput>;
const realAi = secretaryAi.impl;

beforeEach(() => {
  seen = [];
  answer = () => ({ summary: "Nada.", projects: [], tasks: [], notes: [], minutes: "", decisions: [] });
  secretaryAi.impl = async (_env, input, context) => {
    seen.push({ input, context });
    return answer(context);
  };
});
afterEach(() => {
  secretaryAi.impl = realAi;
});

const task = (title: string, extra: Partial<ProposalOutput["tasks"][number]> = {}): ProposalOutput["tasks"][number] => ({
  title,
  description: null,
  priority: "medium",
  assigneeId: null,
  assigneeName: null,
  dueDate: null,
  projectId: null,
  projectRef: null,
  checklist: [],
  ...extra,
});

async function waitDraft(u: TestUser, id: string) {
  for (let i = 0; i < 50; i++) {
    const d = await json(await call(u, "GET", `/api/secretary/drafts/${id}`));
    if (d.status !== "analyzing") return d;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("análise não terminou");
}

async function analyze(u: TestUser, body: Record<string, unknown>) {
  const res = await call(u, "POST", "/api/secretary/analyze", body);
  expect(res.status).toBe(202);
  return waitDraft(u, (await json(res)).id);
}

// ---------- .docx ----------

/** Zip mínimo com um arquivo comprimido (deflate), como o Word grava. */
async function makeDocx(xml: string) {
  const name = new TextEncoder().encode("word/document.xml");
  const raw = new TextEncoder().encode(xml);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, 0, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + data.length, true);
  const out = new Uint8Array(local.length + data.length + central.length + end.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(central, local.length + data.length);
  out.set(end, local.length + data.length + central.length);
  return out;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const ATA_XML =
  '<w:document><w:body><w:p><w:r><w:t>Ata da reunião</w:t></w:r></w:p><w:p><w:r><w:t>Tiago &amp; Lucas: enviar</w:t></w:r><w:r><w:tab/><w:t>orçamento</w:t></w:r></w:p>' +
  "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Prazo</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>";

describe("leitura de .docx", () => {
  it("extrai parágrafos, tabulações, entidades e tabelas", async () => {
    const text = await docxToText(await makeDocx(ATA_XML));
    expect(text).toContain("Ata da reunião\nTiago & Lucas: enviar\torçamento");
    expect(text).toContain("Item");
    expect(text).toContain("Prazo");
  });
});

// ---------- Fluxo pela tela ----------

describe("secretária", () => {
  it("analisa a ata, limpa o que o modelo inventou e cria só o que foi confirmado", async () => {
    const u = await makeUser();
    const project = await json(await call(u, "POST", "/api/projects", { title: "Reforma" }));
    answer = (ctx) => ({
      summary: "Reunião sobre a reforma.",
      projects: [{ ref: "p1", title: "Mudança de escritório", description: "Nova sede", priority: "high" }],
      tasks: [
        task("Contratar eletricista", { assigneeId: ctx.members[0].id, dueDate: "2026-10-10", projectId: project.id, checklist: ["Pedir 3 orçamentos"] }),
        task("Ver imóveis", { priority: "URGENT", assigneeId: "inventado", assigneeName: "Carla", dueDate: "sexta", projectRef: "p1" }),
        task("Tarefa de projeto fantasma", { priority: "alta", projectId: "nao-existe", projectRef: "p9" }),
        task("   "),
      ],
      notes: ["Prazo do piso indefinido."],
      minutes: "Ata da reforma",
      decisions: ["Contratar eletricista"],
    });
    const draft = await analyze(u, { text: "Ata: eletricista até dia 10..." });
    expect(draft.status).toBe("ready");
    expect(seen[0].input).toEqual({ kind: "text", text: "Ata: eletricista até dia 10..." });
    expect(seen[0].context.projects.map((p) => p.id)).toContain(project.id);
    const [t1, t2, t3] = draft.proposal.tasks;
    expect(draft.proposal.tasks).toHaveLength(3);
    expect(t1).toMatchObject({ assigneeId: u.id, dueDate: "2026-10-10", projectId: project.id, checklist: ["Pedir 3 orçamentos"] });
    expect(t2).toMatchObject({ priority: "urgent", assigneeId: null, assigneeName: "Carla", dueDate: null, projectRef: "p1" });
    expect(t3).toMatchObject({ priority: "medium", projectId: null, projectRef: null });

    // A pessoa desmarca a terceira tarefa e ajusta o título da segunda.
    const res = await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, {
      projects: [{ ref: "p1", title: "Mudança de escritório", priority: "high" }],
      tasks: [
        { title: t1.title, assigneeId: t1.assigneeId, dueAt: t1.dueDate, projectId: t1.projectId, checklist: t1.checklist },
        { title: "Visitar imóveis", description: "Responsável citado na ata: Carla.", projectRef: "p1" },
      ],
    });
    expect(res.status).toBe(201);
    const out = await json(res);
    expect(out.taskIds).toHaveLength(2);
    expect(out.projectIds).toHaveLength(1);
    expect(out.draft.status).toBe("applied");

    const created = await db().select().from(tasks).where(eq(tasks.workspaceId, u.workspaceId));
    const eletricista = created.find((t) => t.title === "Contratar eletricista")!;
    const imoveis = created.find((t) => t.title === "Visitar imóveis")!;
    expect(eletricista).toMatchObject({ assigneeId: u.id, projectId: project.id });
    expect(eletricista.description).toContain("Criada pela secretária");
    expect(imoveis.projectId).toBe(out.projectIds[0]);
    const items = await db().select().from(taskItems).where(eq(taskItems.taskId, eletricista.id));
    expect(items.map((i) => i.text)).toEqual(["Pedir 3 orçamentos"]);

    // Confirmar de novo não duplica.
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [{ title: "x" }] })).status).toBe(409);
    expect((await db().select().from(tasks).where(eq(tasks.workspaceId, u.workspaceId))).length).toBe(2);
  });

  it("recusa referências inválidas sem gastar a proposta", async () => {
    const u = await makeUser();
    const other = await makeUser();
    const foreign = await json(await call(other, "POST", "/api/projects", { title: "Alheio" }));
    answer = () => ({ summary: "", projects: [], tasks: [task("Algo")], notes: [], minutes: "", decisions: [] });
    const draft = await analyze(u, { text: "ata" });
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [{ title: "A", projectRef: "p1" }] })).status).toBe(400);
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [{ title: "A", projectId: foreign.id }] })).status).toBe(400);
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [{ title: "A", assigneeId: other.id }] })).status).toBe(400);
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [{ title: "A", dueAt: "ontem??" }] })).status).toBe(400);
    expect((await json(await call(u, "GET", `/api/secretary/drafts/${draft.id}`))).status).toBe("ready");
    // Outro workspace não vê nem aplica.
    expect((await call(other, "GET", `/api/secretary/drafts/${draft.id}`)).status).toBe(404);
    expect((await call(other, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [{ title: "A" }] })).status).toBe(404);
    // Descartada não pode mais ser aplicada.
    expect((await json(await call(u, "POST", `/api/secretary/drafts/${draft.id}/discard`, {}))).status).toBe("discarded");
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [{ title: "A" }] })).status).toBe(409);
  });

  it("falha com mensagem clara e permite tentar de novo", async () => {
    const u = await makeUser();
    answer = () => {
      throw new SecretaryError("limite de uso da API do Claude atingido; tente daqui a pouco");
    };
    const draft = await analyze(u, { text: "ata" });
    expect(draft).toMatchObject({ status: "failed", canRetry: true, error: expect.stringContaining("limite") });
    answer = () => ({ summary: "ok", projects: [], tasks: [task("Ligar")], notes: [], minutes: "", decisions: [] });
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/retry`, {})).status).toBe(202);
    expect((await waitDraft(u, draft.id)).status).toBe("ready");
  });

  it("liga as tarefas à reunião de origem", async () => {
    const u = await makeUser();
    const ev = await json(await call(u, "POST", "/api/events", { title: "Reunião com arquiteto", startAt: "2026-10-05T14:00", endAt: "2026-10-05T15:00" }));
    answer = () => ({ summary: "", projects: [], tasks: [task("Enviar planta")], notes: [], minutes: "", decisions: [] });
    const draft = await analyze(u, { text: "ata", eventId: ev.id });
    expect(seen[0].context.meeting).toMatchObject({ title: "Reunião com arquiteto" });
    const out = await json(await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [{ title: "Enviar planta" }] }));
    const row = await db().query.tasks.findFirst({ where: eq(tasks.id, out.taskIds[0]) });
    expect(row?.sourceEventId).toBe(ev.id);
  });

  it("lê arquivos: PDF vai inteiro, Word vira texto, .doc é recusado", async () => {
    const u = await makeUser();
    const pdf = new TextEncoder().encode("%PDF-1.4 conteúdo");
    expect((await analyze(u, { file: { name: "ata.pdf", data: b64(pdf) } })).sourceName).toBe("ata.pdf");
    expect(seen[0].input).toEqual({ kind: "pdf", data: b64(pdf) });
    await analyze(u, { file: { name: "ata.docx", data: b64(await makeDocx(ATA_XML)) } });
    expect(seen[1].input.kind).toBe("text");
    expect((seen[1].input as { text: string }).text).toContain("Tiago & Lucas");
    expect((await call(u, "POST", "/api/secretary/analyze", { file: { name: "ata.doc", data: b64(new Uint8Array([0xd0, 0xcf, 0, 1])) } })).status).toBe(400);
    expect((await call(u, "POST", "/api/secretary/analyze", { text: "  " })).status).toBe(400);
  });

  it("instruções próprias: só dono ou admin altera, e elas chegam à análise", async () => {
    const u = await makeUser();
    const member = await makeUser({ workspaceId: u.workspaceId, role: "member" });
    expect((await call(member, "PUT", "/api/secretary/settings", { instructions: "x" })).status).toBe(403);
    expect((await call(u, "PUT", "/api/secretary/settings", { instructions: "  Títulos no infinitivo.  " })).status).toBe(200);
    const overview = await json(await call(u, "GET", "/api/secretary"));
    expect(overview).toMatchObject({ enabled: true, instructions: "Títulos no infinitivo." });
    await analyze(u, { text: "ata" });
    expect(seen[0].context.instructions).toBe("Títulos no infinitivo.");
    expect((await json(await call(u, "GET", "/api/secretary"))).drafts).toHaveLength(1);
  });
});

// ---------- Telegram ----------

describe("secretária pelo Telegram", () => {
  let sent: { method: string; body: any }[] = [];
  const realTg = telegramFetch.impl;
  const docx = makeDocx(ATA_XML);
  beforeEach(() => {
    sent = [];
    telegramFetch.impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/file/bot")) return new Response(await docx);
      const method = url.split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      sent.push({ method, body });
      const result = method === "getFile" ? { file_path: "documents/ata.docx" } : method === "sendMessage" ? { message_id: 1 } : true;
      return new Response(JSON.stringify({ ok: true, result }));
    }) as typeof fetch;
  });
  afterEach(() => {
    telegramFetch.impl = realTg;
  });

  let updateId = 9000;
  const deps = { db: db(), env };
  const messages = () => sent.filter((c) => c.method === "sendMessage").map((c) => c.body);

  it("recebe o arquivo, manda a proposta e cria tudo com um toque", async () => {
    const u = await makeUser();
    const from = 77001;
    const { code } = await createLinkCode(db(), u.workspaceId, u.id);
    await handleUpdate(deps, { update_id: ++updateId, message: { message_id: 1, from: { id: from }, chat: { id: from, type: "private" }, text: `/start ${code}` } });
    answer = () => ({
      summary: "Orçamento da obra.",
      projects: [{ ref: "p1", title: "Obra", description: null, priority: "medium" }],
      tasks: [task("Enviar orçamento", { assigneeName: "Tiago", dueDate: "2026-10-09", projectRef: "p1" })],
      notes: [],
      minutes: "",
      decisions: [],
    });
    const doc: TgUpdate = {
      update_id: ++updateId,
      message: { message_id: 2, from: { id: from }, chat: { id: from, type: "private" }, document: { file_id: "F1", file_name: "ata.docx", file_size: 1000 } },
    };
    expect(await handleUpdate(deps, doc)).toBe("ok");
    expect((seen[0].input as { text: string }).text).toContain("Tiago & Lucas");
    const proposal = messages().at(-1);
    expect(proposal.text).toContain("Enviar orçamento (Tiago, até 09/10, Obra)");
    expect(proposal.text).toContain("/secretaria?proposta=");
    const create = proposal.reply_markup.inline_keyboard[0][0];
    expect(create.text).toBe("Criar tudo");

    await handleUpdate(deps, { update_id: ++updateId, callback_query: { id: "cb1", from: { id: from }, data: create.callback_data, message: { message_id: 3, chat: { id: from, type: "private" } } } });
    const edit = sent.filter((c) => c.method === "editMessageText").at(-1)!.body;
    expect(edit.text).toContain("criei 1 tarefa e 1 projeto");
    const row = (await db().select().from(tasks).where(eq(tasks.workspaceId, u.workspaceId)))[0];
    expect(row.description).toContain("Responsável citado na ata: Tiago.");
    const drafts = await db().select().from(secretaryDrafts).where(eq(secretaryDrafts.workspaceId, u.workspaceId));
    expect(drafts[0].status).toBe("applied");
  });

  it("/ata com texto e descarte pelo botão", async () => {
    const u = await makeUser();
    const from = 77002;
    const { code } = await createLinkCode(db(), u.workspaceId, u.id);
    await handleUpdate(deps, { update_id: ++updateId, message: { message_id: 1, from: { id: from }, chat: { id: from, type: "private" }, text: `/start ${code}` } });
    answer = () => ({ summary: "", projects: [], tasks: [task("Ligar para o contador")], notes: [], minutes: "", decisions: [] });
    await handleUpdate(deps, { update_id: ++updateId, message: { message_id: 2, from: { id: from }, chat: { id: from, type: "private" }, text: "/ata Lucas liga para o contador amanhã" } });
    expect(seen[0].input).toEqual({ kind: "text", text: "Lucas liga para o contador amanhã" });
    const discard = messages().at(-1).reply_markup.inline_keyboard[0][1];
    await handleUpdate(deps, { update_id: ++updateId, callback_query: { id: "cb2", from: { id: from }, data: discard.callback_data, message: { message_id: 3, chat: { id: from, type: "private" } } } });
    const drafts = await db().select().from(secretaryDrafts).where(eq(secretaryDrafts.workspaceId, u.workspaceId));
    expect(drafts[0].status).toBe("discarded");
    expect((await db().select().from(tasks).where(eq(tasks.workspaceId, u.workspaceId))).length).toBe(0);
    expect((await db().select().from(pendingConfirmations).where(eq(pendingConfirmations.workspaceId, u.workspaceId)))[0].status).toBe("cancelled");
  });
});

// ---------- Gravações (transcrição) ----------

describe("transcrição de reuniões", () => {
  type Call = { url: string; method: string; body: unknown; auth: string | null };
  let calls: Call[] = [];
  let transcript: Record<string, unknown>;
  const realAssembly = assemblyFetch.impl;
  beforeEach(() => {
    calls = [];
    transcript = {
      status: "completed",
      text: "Bom dia. Tiago envia o orçamento até sexta.",
      utterances: [
        { speaker: "A", text: "Bom dia.", start: 1200 },
        { speaker: "B", text: " Tiago envia o orçamento até sexta. ", start: 65_000 },
      ],
    };
    assemblyFetch.impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = url.endsWith("/upload") ? new Uint8Array(await new Response(init!.body).arrayBuffer()) : init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/upload")) return Response.json({ upload_url: "https://cdn.assemblyai.test/abc" });
      if (url.endsWith("/transcript") && method === "POST") return Response.json({ id: "tr_1", status: "queued" });
      return Response.json(transcript);
    }) as typeof fetch;
  });
  afterEach(() => {
    assemblyFetch.impl = realAssembly;
  });

  async function waitStatus(u: TestUser, id: string) {
    for (let i = 0; i < 100; i++) {
      const d = await json(await call(u, "GET", `/api/secretary/drafts/${id}`));
      if (d.status !== "analyzing" && d.status !== "transcribing") return d;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("não terminou");
  }

  const upload = (u: TestUser, query: string, data = "áudio falso") =>
    call(u, "POST", `/api/secretary/recording${query}`, data, { "content-type": "audio/mpeg", "x-central-upload": "1" });

  it("transcreve a gravação, escreve a ata e guarda ata e decisões na reunião ao confirmar", async () => {
    const u = await makeUser();
    expect(await json(await call(u, "GET", "/api/secretary"))).toMatchObject({ enabled: true, transcription: true });
    const ev = await json(await call(u, "POST", "/api/events", { title: "Reunião da obra", startAt: "2026-10-12T10:00", endAt: "2026-10-12T11:00" }));
    // A reunião já tinha anotações: nada delas se perde.
    await call(u, "PUT", `/api/events/${ev.id}/notes`, { agenda: "Pauta: orçamento", summary: "Anotação minha.", decisions: [{ text: "Fechar com a construtora" }] });
    answer = () => ({
      summary: "Orçamento da obra.",
      projects: [],
      tasks: [task("Enviar orçamento", { dueDate: "2026-10-16" })],
      notes: [],
      minutes: "ATA DA REUNIÃO\nParticipantes: Pessoa A, Pessoa B.",
      decisions: ["Fechar com a construtora", "Orçamento vai até sexta"],
    });

    // Sem o cabeçalho próprio, o envio cru é recusado (proteção CSRF).
    expect((await call(u, "POST", "/api/secretary/recording?name=x.mp3", "áudio", { "content-type": "audio/mpeg" })).status).toBe(415);

    const res = await upload(u, "?name=reuniao.m4a");
    expect(res.status).toBe(202);
    const created = await json(res);
    expect(created).toMatchObject({ sourceName: "reuniao.m4a", inputKind: "transcript" });
    const draft = await waitStatus(u, created.id);
    expect(draft.status).toBe("ready");

    // O áudio foi para a AssemblyAI, em português e separando quem fala.
    expect(calls[0]).toMatchObject({ method: "POST", auth: "aai-teste" });
    expect(new TextDecoder().decode(calls[0].body as Uint8Array)).toBe("áudio falso");
    expect(calls[1].body).toMatchObject({ audio_url: "https://cdn.assemblyai.test/abc", language_code: "pt", speaker_labels: true });
    expect(calls[2].url).toContain("/transcript/tr_1");

    // A secretária recebeu a transcrição com tempo e locutor.
    expect(seen[0].input).toEqual({ kind: "transcript", text: "[00:01] Pessoa A: Bom dia.\n[01:05] Pessoa B: Tiago envia o orçamento até sexta." });
    expect(draft.transcript).toContain("Pessoa B");
    expect(draft.proposal.minutes).toContain("ATA DA REUNIÃO");

    // A pessoa escolhe a reunião na revisão e ajusta a ata.
    const out = await json(
      await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, {
        projects: [],
        tasks: [{ title: "Enviar orçamento", dueAt: "2026-10-16" }],
        minutes: "ATA DA REUNIÃO (revisada)",
        decisions: draft.proposal.decisions,
        eventId: ev.id,
      }),
    );
    expect(out.draft).toMatchObject({ status: "applied", eventId: ev.id });
    const row = await db().query.tasks.findFirst({ where: eq(tasks.id, out.taskIds[0]) });
    expect(row?.sourceEventId).toBe(ev.id);
    expect(row?.dueAt).not.toBeNull();
    const notes = await json(await call(u, "GET", `/api/events/${ev.id}/notes`));
    expect(notes.agenda).toBe("Pauta: orçamento");
    expect(notes.summary).toContain("Anotação minha.");
    expect(notes.summary).toContain("ATA DA REUNIÃO (revisada)");
    // A decisão repetida não é duplicada.
    expect(notes.decisions.map((d: { text: string }) => d.text)).toEqual(["Fechar com a construtora", "Orçamento vai até sexta"]);
  });

  it("guarda só a ata quando não há tarefas, e exige reunião para isso", async () => {
    const u = await makeUser();
    const ev = await json(await call(u, "POST", "/api/events", { title: "Alinhamento", startAt: "2026-10-12T10:00", endAt: "2026-10-12T11:00" }));
    answer = () => ({ summary: "", projects: [], tasks: [], notes: [], minutes: "Só conversa.", decisions: [] });
    const draft = await waitStatus(u, (await json(await upload(u, `?name=a.mp3&eventId=${ev.id}`))).id);
    expect(draft.eventId).toBe(ev.id);
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [], minutes: "Só conversa.", eventId: null })).status).toBe(400);
    expect((await call(u, "POST", `/api/secretary/drafts/${draft.id}/apply`, { projects: [], tasks: [], minutes: "Só conversa." })).status).toBe(201);
    expect((await json(await call(u, "GET", `/api/events/${ev.id}/notes`))).summary).toBe("Só conversa.");
  });

  it("falha da transcrição vira mensagem clara", async () => {
    const u = await makeUser();
    transcript = { status: "error", text: null, error: "arquivo sem áudio" };
    const draft = await waitStatus(u, (await json(await upload(u, "?name=video.mp4"))).id);
    expect(draft).toMatchObject({ status: "failed", canRetry: false, error: expect.stringContaining("arquivo sem áudio") });
    expect(seen).toHaveLength(0);
    // Reunião de outro workspace é recusada.
    const other = await makeUser();
    const ev = await json(await call(other, "POST", "/api/events", { title: "X", startAt: "2026-10-12T10:00", endAt: "2026-10-12T11:00" }));
    expect((await upload(u, `?eventId=${ev.id}`)).status).toBe(400);
  });

  it("retoma pelo cron uma transcrição que ficou sem acompanhamento", async () => {
    const u = await makeUser();
    answer = () => ({ summary: "", projects: [], tasks: [task("Ligar")], notes: [], minutes: "Ata", decisions: [] });
    const id = "rascunho-parado";
    await db().insert(secretaryDrafts).values({ id, workspaceId: u.workspaceId, userId: u.id, source: "web", sourceName: "g.mp3", inputKind: "transcript", transcriptId: "tr_9", status: "transcribing", updatedAt: Date.now() - 10 * 60_000 });
    expect(await resumeTranscriptions({ db: db(), env })).toBe(1);
    const d = await json(await call(u, "GET", `/api/secretary/drafts/${id}`));
    expect(d.status).toBe("ready");
    expect(calls.at(-1)!.url).toContain("/transcript/tr_9");
  });

  it("formata a transcrição sem locutores como texto corrido", () => {
    expect(formatTranscript({ text: " Olá ", utterances: null })).toBe("Olá");
    expect(formatTranscript({ text: "", utterances: [{ speaker: "C", text: "Fim", start: 3_725_000 }] })).toBe("[1:02:05] Pessoa C: Fim");
  });

  it("recebe mensagem de voz pelo Telegram e manda a proposta quando a transcrição termina", async () => {
    const u = await makeUser();
    const from = 77003;
    const sent: { method: string; body: any }[] = [];
    const realTg = telegramFetch.impl;
    telegramFetch.impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
      const method = url.split("/").pop()!;
      sent.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
      const result = method === "getFile" ? { file_path: "voice/file_1.oga" } : method === "sendMessage" ? { message_id: 1 } : true;
      return new Response(JSON.stringify({ ok: true, result }));
    }) as typeof fetch;
    try {
      const deps = { db: db(), env };
      const { code } = await createLinkCode(db(), u.workspaceId, u.id);
      await handleUpdate(deps, { update_id: 99001, message: { message_id: 1, from: { id: from }, chat: { id: from, type: "private" }, text: `/start ${code}` } });
      answer = () => ({ summary: "Recado.", projects: [], tasks: [task("Pagar boleto", { dueDate: "2026-10-15" })], notes: [], minutes: "Ata curta", decisions: [] });
      const voice: TgUpdate = { update_id: 99002, message: { message_id: 2, from: { id: from }, chat: { id: from, type: "private" }, voice: { file_id: "V1", file_size: 3 } } };
      expect(await handleUpdate(deps, voice)).toBe("ok");
      expect(Array.from(calls[0].body as Uint8Array)).toEqual([1, 2, 3]);
      const texts = sent.filter((c) => c.method === "sendMessage").map((c) => c.body.text as string);
      expect(texts.some((t) => t.includes("Vou transcrever"))).toBe(true);
      expect(texts.at(-1)).toContain("Pagar boleto (até 15/10)");
      const drafts = await db().select().from(secretaryDrafts).where(eq(secretaryDrafts.workspaceId, u.workspaceId));
      expect(drafts[0]).toMatchObject({ status: "ready", sourceName: "Áudio do Telegram", inputKind: "transcript" });
    } finally {
      telegramFetch.impl = realTg;
    }
  });
});
