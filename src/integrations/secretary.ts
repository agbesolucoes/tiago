// Secretária: lê uma ata de reunião e propõe projetos e tarefas para a Central, usando a API do Claude.
// A proposta só vira registro depois que a pessoa revisa e confirma (applyProposal).

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { RequestContext } from "../api/context";
import { auditInsert, ValidationError } from "../api/helpers";
import type { Db } from "../db/client";
import { events, memberships, priorities, projects, secretaryDrafts, taskItems, tasks, users, workspaces, type SecretaryProposal } from "../db/schema";
import type { Env } from "../env";
import { newId } from "../lib/crypto";
import { DocxError, docxToText } from "../lib/docx";
import { recordError } from "../lib/log";
import { formatLocal, parseDateTime } from "../lib/time";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Uma análise parada há mais que isso (servidor reiniciado no meio) aparece como falha. */
export const ANALYSIS_TIMEOUT = 15 * 60_000;
const MAX_TASKS = 100;
const MAX_PROJECTS = 20;

export function secretaryEnabled(env: Env) {
  return !!env.ANTHROPIC_API_KEY;
}

// ---------- Formato da resposta ----------

const priority = z.enum(priorities);
// Na resposta do modelo a prioridade vem como texto livre (o formato estruturado não guarda enums) e é conferida em cleanProposal.
const outPriority = z.string().describe('Uma destas: "low", "medium", "high" ou "urgent".');
const toPriority = (p: string) => ((priorities as readonly string[]).includes(p.trim().toLowerCase()) ? (p.trim().toLowerCase() as (typeof priorities)[number]) : "medium");

const proposalSchema = z.object({
  summary: z.string().describe("Resumo da reunião em 2 a 5 frases, em português."),
  projects: z
    .array(
      z.object({
        ref: z.string().describe("Identificador curto para as tarefas apontarem para este projeto novo, como p1, p2."),
        title: z.string(),
        description: z.string().nullable(),
        priority: outPriority,
      }),
    )
    .describe("Projetos NOVOS. Só quando a ata trata de uma frente de trabalho com várias tarefas que não corresponde a nenhum projeto existente."),
  tasks: z.array(
    z.object({
      title: z.string().describe("Ação concreta começando com verbo, até 120 caracteres."),
      description: z.string().nullable().describe("Contexto necessário para executar a tarefa sem reler a ata."),
      priority: outPriority,
      assigneeId: z.string().nullable().describe("id do membro da Central, só quando o responsável citado é claramente essa pessoa."),
      assigneeName: z.string().nullable().describe("Nome do responsável como aparece na ata, mesmo que não seja membro."),
      dueDate: z.string().nullable().describe("Prazo no formato AAAA-MM-DD, só quando a ata indica um prazo."),
      projectId: z.string().nullable().describe("id de um projeto existente da Central ao qual a tarefa pertence."),
      projectRef: z.string().nullable().describe("ref de um projeto novo desta proposta ao qual a tarefa pertence."),
      checklist: z.array(z.string()).describe("Passos menores, quando a ata os detalha. Pode ser vazio."),
    }),
  ),
  notes: z.array(z.string()).describe("Pontos de atenção para quem revisa: pendências sem responsável, prazos ambíguos, decisões sem ação clara."),
});

const BASE_INSTRUCTIONS = `Você é a secretária da Central de Organização, um sistema pessoal de tarefas, projetos e agenda.
Você recebe a ata ou as anotações de uma reunião e propõe o que deve ser registrado na Central. Uma pessoa vai revisar sua proposta antes de qualquer coisa ser gravada.

Como trabalhar:
- Transforme em tarefa cada ação, encaminhamento ou compromisso assumido na reunião. Não crie tarefas para assuntos apenas discutidos, sem ação.
- Use títulos curtos e concretos, começando com verbo (ex.: "Enviar orçamento revisado ao cliente").
- Quando a ata nomeia um responsável, preencha assigneeName. Preencha assigneeId só se o nome corresponder claramente a um dos membros listados.
- Converta prazos relativos ("até sexta", "semana que vem") em datas usando a data de hoje informada. Se o prazo for vago, deixe dueDate vazio e explique em notes.
- Ligue a tarefa a um projeto existente quando o assunto for claramente dele. Proponha projeto novo só para uma frente de trabalho com várias tarefas.
- Prioridade: urgent só para o que a ata trata como urgente; high para prazos próximos ou itens críticos; medium no geral; low para o que é opcional.
- Não invente informações que não estão na ata. Escreva sempre em português do Brasil.`;

// ---------- Chamada ao modelo ----------

export type SecretaryInput = { kind: "text"; text: string } | { kind: "pdf"; data: string };

export interface SecretaryContext {
  today: string;
  timezone: string;
  members: { id: string; name: string | null; email: string }[];
  projects: { id: string; title: string }[];
  meeting: { title: string; when: string } | null;
  instructions: string | null;
}

export type ProposalOutput = z.infer<typeof proposalSchema>;

/** Trocado nos testes por uma resposta pronta. */
export const secretaryAi: { impl: (env: Env, input: SecretaryInput, context: SecretaryContext) => Promise<ProposalOutput> } = {
  impl: callClaude,
};

export class SecretaryError extends Error {}

async function callClaude(env: Env, input: SecretaryInput, context: SecretaryContext): Promise<ProposalOutput> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const system = context.instructions?.trim()
    ? `${BASE_INSTRUCTIONS}\n\nInstruções do dono da Central (siga quando não contrariarem as regras acima):\n${context.instructions.trim()}`
    : BASE_INSTRUCTIONS;
  const facts = {
    hoje: context.today,
    fuso: context.timezone,
    reuniao: context.meeting,
    membros: context.members,
    projetosExistentes: context.projects,
  };
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (input.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.data } });
  content.push({
    type: "text",
    text: `Dados da Central:\n${JSON.stringify(facts, null, 2)}\n\n${input.kind === "text" ? `Ata da reunião:\n<ata>\n${input.text}\n</ata>` : "A ata da reunião está no PDF acima."}\n\nProponha o que registrar.`,
  });
  try {
    const response = await client.beta.messages.parse({
      model: env.SECRETARY_MODEL || DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content }],
      output_config: { effort: "medium", format: betaZodOutputFormat(proposalSchema) },
    });
    if (response.stop_reason === "refusal") throw new SecretaryError("a análise foi recusada pelo modelo; revise o conteúdo da ata");
    if (response.stop_reason === "max_tokens") throw new SecretaryError("a ata é longa demais para uma análise só; divida em partes");
    if (!response.parsed_output) throw new SecretaryError("a resposta veio incompleta; tente de novo");
    return response.parsed_output;
  } catch (e) {
    if (e instanceof SecretaryError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new SecretaryError("a chave da API do Claude (ANTHROPIC_API_KEY) foi recusada");
    if (e instanceof Anthropic.RateLimitError) throw new SecretaryError("limite de uso da API do Claude atingido; tente daqui a pouco");
    if (e instanceof Anthropic.BadRequestError) throw new SecretaryError(`a API do Claude recusou o pedido: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new SecretaryError(`a API do Claude falhou (${e.status ?? "sem conexão"}); tente de novo`);
    throw e;
  }
}

// ---------- Leitura do arquivo ----------

export class MinutesError extends Error {}

function bytesToBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Transforma o arquivo da ata em entrada para a análise: PDF vai inteiro; Word e texto viram texto. */
export async function readMinutes(name: string, bytes: Uint8Array): Promise<SecretaryInput> {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const magic = new TextDecoder().decode(bytes.subarray(0, 5));
  if (ext === "pdf" || magic === "%PDF-") {
    if (magic !== "%PDF-") throw new MinutesError("o arquivo não é um PDF válido");
    return { kind: "pdf", data: bytesToBase64(bytes) };
  }
  if (ext === "docx" || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    let text: string;
    try {
      text = await docxToText(bytes);
    } catch (e) {
      throw new MinutesError(e instanceof DocxError ? e.message : "não consegui ler o .docx");
    }
    if (!text.trim()) throw new MinutesError("o .docx não tem texto");
    return { kind: "text", text };
  }
  if (ext === "doc") throw new MinutesError("arquivos .doc antigos não são lidos; salve como .docx ou PDF");
  const text = new TextDecoder().decode(bytes);
  if (text.includes("\u0000")) throw new MinutesError("formato não reconhecido; envie PDF, .docx ou texto");
  if (!text.trim()) throw new MinutesError("o arquivo está vazio");
  return { kind: "text", text: text.trim() };
}

// ---------- Contexto e limpeza ----------

function localDate(ms: number, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

export async function buildContext(db: Db, workspaceId: string, eventId: string | null, now = Date.now()): Promise<SecretaryContext> {
  const ws = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) }))!;
  const tz = ws.timezone;
  const [members, open, ev] = await Promise.all([
    db.select({ id: users.id, name: users.name, email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.workspaceId, workspaceId)),
    db
      .select({ id: projects.id, title: projects.title })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), inArray(projects.status, ["active", "paused"])))
      .limit(200),
    eventId ? db.query.events.findFirst({ where: and(eq(events.id, eventId), eq(events.workspaceId, workspaceId)) }) : undefined,
  ]);
  const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long" }).format(new Date(now));
  return {
    today: `${localDate(now, tz)} (${weekday})`,
    timezone: tz,
    members,
    projects: open,
    meeting: ev ? { title: ev.title, when: formatLocal(ev.startAt, ev.timezone) } : null,
    instructions: ws.secretaryInstructions,
  };
}

const cut = (s: string | null | undefined, n: number) => {
  const t = s?.trim();
  return t ? t.slice(0, n) : null;
};

/** O modelo pode errar ids e datas: só passa o que existe de fato na Central. */
export function cleanProposal(raw: ProposalOutput, context: SecretaryContext): SecretaryProposal {
  const memberIds = new Set(context.members.map((m) => m.id));
  const projectIds = new Set(context.projects.map((p) => p.id));
  const newProjects = raw.projects.slice(0, MAX_PROJECTS).flatMap((p, i) => {
    const title = cut(p.title, 200);
    return title ? [{ ref: cut(p.ref, 20) ?? `p${i + 1}`, title, description: cut(p.description, 10_000), priority: toPriority(p.priority) }] : [];
  });
  const refs = new Set(newProjects.map((p) => p.ref));
  return {
    summary: cut(raw.summary, 5000) ?? "",
    projects: newProjects,
    tasks: raw.tasks.slice(0, MAX_TASKS).flatMap((t) => {
      const title = cut(t.title, 200);
      if (!title) return [];
      const projectId = t.projectId && projectIds.has(t.projectId) ? t.projectId : null;
      return [
        {
          title,
          description: cut(t.description, 10_000),
          priority: toPriority(t.priority),
          assigneeId: t.assigneeId && memberIds.has(t.assigneeId) ? t.assigneeId : null,
          assigneeName: cut(t.assigneeName, 120),
          dueDate: t.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) && parseDateTime(t.dueDate, context.timezone) !== null ? t.dueDate : null,
          projectId,
          projectRef: !projectId && t.projectRef && refs.has(t.projectRef) ? t.projectRef : null,
          checklist: t.checklist.flatMap((c) => cut(c, 500) ?? []).slice(0, 30),
        },
      ];
    }),
    notes: raw.notes.flatMap((n) => cut(n, 1000) ?? []).slice(0, 30),
  };
}

// ---------- Análise em segundo plano ----------

/** Guarda a ata recebida; a análise é rodada à parte por runAnalysis. */
export async function createDraft(
  ctx: Pick<RequestContext, "db" | "workspaceId" | "userId">,
  d: { source: (typeof secretaryDrafts.$inferSelect)["source"]; sourceName: string; eventId: string | null; input: SecretaryInput },
) {
  const row = {
    id: newId(),
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    source: d.source,
    sourceName: d.sourceName.slice(0, 200),
    eventId: d.eventId,
    inputText: d.input.kind === "text" ? d.input.text : null,
    status: "analyzing" as const,
  };
  await ctx.db.insert(secretaryDrafts).values(row);
  return (await ctx.db.query.secretaryDrafts.findFirst({ where: eq(secretaryDrafts.id, row.id) }))!;
}


/** Roda a análise de um rascunho e grava o resultado (ready ou failed). Nunca lança. */
export async function runAnalysis(deps: { db: Db; env: Env }, draftId: string, input: SecretaryInput) {
  const { db, env } = deps;
  const draft = await db.query.secretaryDrafts.findFirst({ where: eq(secretaryDrafts.id, draftId) });
  if (!draft) return null;
  let values: Partial<typeof secretaryDrafts.$inferInsert>;
  try {
    const context = await buildContext(db, draft.workspaceId, draft.eventId);
    const raw = await secretaryAi.impl(env, input, context);
    values = { status: "ready", proposal: cleanProposal(raw, context), error: null };
  } catch (e) {
    if (!(e instanceof SecretaryError)) await recordError(db, "secretaria", e);
    values = { status: "failed", error: e instanceof SecretaryError ? e.message : "a análise falhou; tente de novo" };
  }
  await db
    .update(secretaryDrafts)
    .set({ ...values, updatedAt: Date.now() })
    .where(and(eq(secretaryDrafts.id, draftId), eq(secretaryDrafts.status, "analyzing")));
  return db.query.secretaryDrafts.findFirst({ where: eq(secretaryDrafts.id, draftId) });
}

// ---------- Aplicar ----------

export const applyBody = z.strictObject({
  projects: z
    .array(
      z.strictObject({
        ref: z.string().min(1).max(20),
        title: z.string().trim().min(1, "título obrigatório").max(200),
        description: z.string().max(10_000).nullable().optional(),
        priority: priority.optional(),
      }),
    )
    .max(MAX_PROJECTS),
  tasks: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1, "título obrigatório").max(200),
        description: z.string().max(10_000).nullable().optional(),
        priority: priority.optional(),
        assigneeId: z.string().min(1).max(64).nullable().optional(),
        dueAt: z.string().min(10).max(40).nullable().optional(),
        projectId: z.string().min(1).max(64).nullable().optional(),
        projectRef: z.string().min(1).max(20).nullable().optional(),
        checklist: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
      }),
    )
    .max(MAX_TASKS),
});
export type ApplyBody = z.infer<typeof applyBody>;

/** A proposta como veio da secretária, no formato de applyBody (usado pelo "Criar tudo" do Telegram). */
export function proposalAsBody(p: SecretaryProposal): ApplyBody {
  return {
    projects: p.projects.map(({ ref, title, description, priority }) => ({ ref, title, description, priority })),
    tasks: p.tasks.map((t) => ({
      title: t.title,
      description: describe(t.description, t.assigneeId ? null : t.assigneeName),
      priority: t.priority,
      assigneeId: t.assigneeId,
      dueAt: t.dueDate,
      projectId: t.projectId,
      projectRef: t.projectRef,
      checklist: t.checklist,
    })),
  };
}

/** Responsável citado que não é membro fica registrado na descrição. */
export function describe(description: string | null, assigneeName: string | null) {
  if (!assigneeName) return description;
  return [description, `Responsável citado na ata: ${assigneeName}.`].filter(Boolean).join("\n\n");
}

export class DraftConflict extends Error {}

/** Cria os projetos e tarefas aprovados e marca o rascunho como aplicado. Dois cliques não gravam duas vezes. */
export async function applyProposal(ctx: RequestContext, draft: typeof secretaryDrafts.$inferSelect, body: ApplyBody) {
  const refs = new Map(body.projects.map((p) => [p.ref, newId()]));
  const issues: { path: string; message: string }[] = [];
  body.tasks.forEach((t, i) => {
    if (t.projectRef && !refs.has(t.projectRef)) issues.push({ path: `tasks.${i}.projectRef`, message: "projeto novo não encontrado na proposta" });
  });
  const projectIds = [...new Set(body.tasks.flatMap((t) => (t.projectId ? [t.projectId] : [])))];
  const assigneeIds = [...new Set(body.tasks.flatMap((t) => (t.assigneeId ? [t.assigneeId] : [])))];
  const [okProjects, okMembers] = await Promise.all([
    projectIds.length ? ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.workspaceId, ctx.workspaceId), inArray(projects.id, projectIds))) : [],
    assigneeIds.length ? ctx.db.select({ id: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, ctx.workspaceId), inArray(memberships.userId, assigneeIds))) : [],
  ]);
  const validProjects = new Set(okProjects.map((r) => r.id));
  const validMembers = new Set(okMembers.map((r) => r.id));
  const dueAt = body.tasks.map((t, i) => {
    if (t.projectId && !validProjects.has(t.projectId)) issues.push({ path: `tasks.${i}.projectId`, message: "não encontrado neste workspace" });
    if (t.assigneeId && !validMembers.has(t.assigneeId)) issues.push({ path: `tasks.${i}.assigneeId`, message: "não é membro deste workspace" });
    if (!t.dueAt) return null;
    const ms = parseDateTime(t.dueAt, ctx.timezone);
    if (ms === null) issues.push({ path: `tasks.${i}.dueAt`, message: "data inválida" });
    return ms;
  });
  if (issues.length) throw new ValidationError(issues);
  if (!body.tasks.length && !body.projects.length) throw new ValidationError([{ path: "tasks", message: "escolha ao menos uma tarefa ou projeto" }]);

  // Só a primeira confirmação passa de ready para applied.
  const now = Date.now();
  const result = { projectIds: [...refs.values()], taskIds: [] as string[] };
  const claimed = await ctx.db
    .update(secretaryDrafts)
    .set({ status: "applied", updatedAt: now })
    .where(and(eq(secretaryDrafts.id, draft.id), eq(secretaryDrafts.workspaceId, ctx.workspaceId), eq(secretaryDrafts.status, "ready")))
    .returning({ id: secretaryDrafts.id });
  if (!claimed.length) throw new DraftConflict("esta proposta já foi aplicada ou descartada");

  const eventId = draft.eventId
    ? ((await ctx.db.query.events.findFirst({ where: and(eq(events.id, draft.eventId), eq(events.workspaceId, ctx.workspaceId)) }))?.id ?? null)
    : null;
  const origin = `Criada pela secretária a partir de “${draft.sourceName}”.`;
  const stmts: any[] = [];
  for (const p of body.projects) {
    const row = { id: refs.get(p.ref)!, workspaceId: ctx.workspaceId, createdBy: ctx.userId, title: p.title, description: p.description ?? null, priority: p.priority };
    stmts.push(ctx.db.insert(projects).values(row), auditInsert(ctx, "project", row.id, "create", null, { title: row.title, via: "secretaria", draftId: draft.id }));
  }
  body.tasks.forEach((t, i) => {
    const id = newId();
    result.taskIds.push(id);
    const row = {
      id,
      workspaceId: ctx.workspaceId,
      createdBy: ctx.userId,
      title: t.title,
      description: [t.description?.trim(), origin].filter(Boolean).join("\n\n"),
      priority: t.priority,
      assigneeId: t.assigneeId ?? null,
      dueAt: dueAt[i],
      projectId: t.projectId ?? (t.projectRef ? refs.get(t.projectRef)! : null),
      sourceEventId: eventId,
    };
    stmts.push(ctx.db.insert(tasks).values(row), auditInsert(ctx, "task", id, "create", null, { title: row.title, via: "secretaria", draftId: draft.id }));
    (t.checklist ?? []).forEach((text, position) => stmts.push(ctx.db.insert(taskItems).values({ id: newId(), workspaceId: ctx.workspaceId, taskId: id, text, position })));
  });
  stmts.push(ctx.db.update(secretaryDrafts).set({ result, updatedAt: now }).where(eq(secretaryDrafts.id, draft.id)));
  try {
    await ctx.db.batch(stmts as [any, ...any[]]);
  } catch (e) {
    // O lote é atômico: nada foi gravado, então a proposta volta a poder ser aplicada.
    await ctx.db.update(secretaryDrafts).set({ status: "ready", updatedAt: Date.now() }).where(and(eq(secretaryDrafts.id, draft.id), ne(secretaryDrafts.status, "discarded")));
    throw e;
  }
  return result;
}
