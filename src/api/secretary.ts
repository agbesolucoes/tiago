import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { events, secretaryDrafts, workspaces } from "../db/schema";
import { ANALYSIS_TIMEOUT, applyBody, applyProposal, createDraft, DraftConflict, MinutesError, readMinutes, runAnalysis, secretaryEnabled, type SecretaryInput } from "../integrations/secretary";
import { requireRole, type AppEnv, type RequestContext } from "./context";
import { auditInsert, notFound, parseBody, serialize, ValidationError } from "./helpers";

/** Arquivo de até 10 MB, em base64 dentro do JSON. */
const MAX_FILE_BASE64 = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4;

const analyzeBody = z
  .strictObject({
    text: z.string().max(200_000).optional(),
    file: z
      .strictObject({
        name: z.string().trim().min(1).max(200),
        data: z.string().min(1).max(MAX_FILE_BASE64, "arquivo maior que 10 MB"),
      })
      .optional(),
    eventId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((b) => !!b.text?.trim() !== !!b.file, { message: "envie o texto da ata ou um arquivo", path: ["text"] });

const settingsBody = z.strictObject({ instructions: z.string().max(20_000).nullable() });

type Draft = typeof secretaryDrafts.$inferSelect;

function view(d: Draft, full = true) {
  // Servidor reiniciado no meio da análise: ela não vai mais terminar.
  const stale = d.status === "analyzing" && d.updatedAt < Date.now() - ANALYSIS_TIMEOUT;
  return serialize({
    id: d.id,
    source: d.source,
    sourceName: d.sourceName,
    eventId: d.eventId,
    status: stale ? "failed" : d.status,
    error: stale ? "a análise não terminou; tente de novo" : d.error,
    canRetry: (stale || d.status === "failed") && !!d.inputText,
    ...(full && { proposal: d.proposal, result: d.result }),
    taskCount: d.proposal?.tasks.length ?? 0,
    projectCount: d.proposal?.projects.length ?? 0,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  });
}

async function getDraft(ctx: RequestContext, id: string) {
  const d = await ctx.db.query.secretaryDrafts.findFirst({ where: and(eq(secretaryDrafts.id, id), eq(secretaryDrafts.workspaceId, ctx.workspaceId)) });
  return d ?? notFound();
}

function base64ToBytes(data: string) {
  try {
    return Uint8Array.from(atob(data.replace(/^data:[^,]*,/, "")), (ch) => ch.charCodeAt(0));
  } catch {
    throw new ValidationError([{ path: "file.data", message: "arquivo inválido" }]);
  }
}

export function registerSecretary(api: Hono<AppEnv>) {
  api.get("/secretary", async (c) => {
    const ctx = c.get("ctx");
    const [ws, drafts] = await Promise.all([
      ctx.db.query.workspaces.findFirst({ where: eq(workspaces.id, ctx.workspaceId) }),
      ctx.db.select().from(secretaryDrafts).where(eq(secretaryDrafts.workspaceId, ctx.workspaceId)).orderBy(desc(secretaryDrafts.createdAt)).limit(20),
    ]);
    return c.json({ enabled: secretaryEnabled(c.env), instructions: ws?.secretaryInstructions ?? null, drafts: drafts.map((d) => view(d, false)) });
  });

  api.put("/secretary/settings", async (c) => {
    const ctx = c.get("ctx");
    requireRole(ctx, "owner", "admin");
    const body = await parseBody(c, settingsBody);
    const instructions = body.instructions?.trim() || null;
    await ctx.db.batch([
      ctx.db.update(workspaces).set({ secretaryInstructions: instructions, updatedAt: Date.now() }).where(eq(workspaces.id, ctx.workspaceId)),
      auditInsert(ctx, "workspace", ctx.workspaceId, "update", null, { secretaryInstructions: instructions ? "alteradas" : "removidas" }),
    ]);
    return c.json({ instructions });
  });

  /** Recebe a ata e começa a análise em segundo plano; a tela acompanha pelo GET do rascunho. */
  api.post("/secretary/analyze", async (c) => {
    const ctx = c.get("ctx");
    if (!secretaryEnabled(c.env)) return c.json({ error: "a secretária não está ligada: falta a chave ANTHROPIC_API_KEY no servidor" }, 409);
    const body = await parseBody(c, analyzeBody);
    if (body.eventId) {
      const ev = await ctx.db.query.events.findFirst({ where: and(eq(events.id, body.eventId), eq(events.workspaceId, ctx.workspaceId)) });
      if (!ev) throw new ValidationError([{ path: "eventId", message: "não encontrado neste workspace" }]);
    }
    let input: SecretaryInput;
    let sourceName = "Texto colado";
    try {
      if (body.file) {
        sourceName = body.file.name;
        input = await readMinutes(body.file.name, base64ToBytes(body.file.data));
      } else input = { kind: "text", text: body.text!.trim() };
    } catch (e) {
      if (e instanceof MinutesError) throw new ValidationError([{ path: "file", message: e.message }]);
      throw e;
    }
    const draft = await createDraft(ctx, { source: "web", sourceName, eventId: body.eventId ?? null, input });
    c.executionCtx.waitUntil(runAnalysis({ db: ctx.db, env: c.env }, draft.id, input));
    return c.json(view(draft), 202);
  });

  api.get("/secretary/drafts/:id", async (c) => c.json(view(await getDraft(c.get("ctx"), c.req.param("id")))));

  api.post("/secretary/drafts/:id/retry", async (c) => {
    const ctx = c.get("ctx");
    if (!secretaryEnabled(c.env)) return c.json({ error: "a secretária não está ligada: falta a chave ANTHROPIC_API_KEY no servidor" }, 409);
    const draft = await getDraft(ctx, c.req.param("id"));
    if (!view(draft).canRetry) return c.json({ error: "esta análise não pode ser repetida; envie a ata de novo" }, 409);
    await ctx.db.update(secretaryDrafts).set({ status: "analyzing", error: null, updatedAt: Date.now() }).where(eq(secretaryDrafts.id, draft.id));
    c.executionCtx.waitUntil(runAnalysis({ db: ctx.db, env: c.env }, draft.id, { kind: "text", text: draft.inputText! }));
    return c.json(view(await getDraft(ctx, draft.id)), 202);
  });

  api.post("/secretary/drafts/:id/apply", async (c) => {
    const ctx = c.get("ctx");
    const draft = await getDraft(ctx, c.req.param("id"));
    const body = await parseBody(c, applyBody);
    try {
      const result = await applyProposal(ctx, draft, body);
      return c.json({ ...result, draft: view(await getDraft(ctx, draft.id)) }, 201);
    } catch (e) {
      if (e instanceof DraftConflict) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  api.post("/secretary/drafts/:id/discard", async (c) => {
    const ctx = c.get("ctx");
    const draft = await getDraft(ctx, c.req.param("id"));
    if (draft.status === "applied") return c.json({ error: "esta proposta já foi aplicada" }, 409);
    await ctx.db.update(secretaryDrafts).set({ status: "discarded", updatedAt: Date.now() }).where(and(eq(secretaryDrafts.id, draft.id), eq(secretaryDrafts.workspaceId, ctx.workspaceId)));
    return c.json(view(await getDraft(ctx, draft.id)));
  });
}
