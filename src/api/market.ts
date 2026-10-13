import { and, desc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { auditLog, marketStudies, priorities, projects } from "../db/schema";
import { newId } from "../lib/crypto";
import { auditInsert, likePattern, notFound, parseBody, serialize } from "./helpers";
import { requireRole, type AppEnv, type RequestContext } from "./context";

// Estudos do analista de mercado Omega (tela Mercado). O analista roda no navegador; aqui só guardamos o resultado.

/** Abaixo do limite de 2 MB por valor do D1, para valer igual na Cloudflare e no SQLite. */
const MAX_STATE = 1_900_000;

const studyCreate = z.strictObject({
  address: z.string().trim().min(1, "endereço obrigatório").max(300),
  city: z.string().trim().max(120).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
  verdict: z.string().trim().max(60).nullable().optional(),
  score: z.number().min(0).max(5).nullable().optional(),
  coverage: z.number().min(0).max(1).nullable().optional(),
  analyzedAt: z.iso.datetime({ offset: true }),
  stateGz: z.string().max(MAX_STATE, "estudo grande demais para guardar").regex(/^[A-Za-z0-9+/=]*$/, "formato inválido").nullable().optional(),
});

const studyProject = z.strictObject({ priority: z.enum(priorities).optional() });

/** Colunas da lista: tudo menos o estado completo, que só vem ao abrir um estudo. */
const { stateGz: _state, ...listColumns } = getTableColumns(marketStudies);

async function getStudy(ctx: RequestContext, id: string) {
  const row = await ctx.db.query.marketStudies.findFirst({ where: and(eq(marketStudies.id, id), eq(marketStudies.workspaceId, ctx.workspaceId)) });
  return row ?? notFound();
}

const fmt = (n: number | null, digits: number) => (n === null ? null : n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }));

function projectDescription(ctx: RequestContext, s: typeof marketStudies.$inferSelect) {
  const lines = [
    "Estudo de mercado Omega Academia",
    `Endereço: ${s.address}${s.city ? ` (${s.city})` : ""}`,
    s.verdict && `Parecer: ${s.verdict}`,
    s.score !== null && `Matriz: ${fmt(s.score, 1)} / 5${s.coverage !== null ? ` (cobertura de ${fmt(s.coverage * 100, 0)}% dos pesos)` : ""}`,
    `Data do estudo: ${new Date(s.analyzedAt).toLocaleDateString("pt-BR", { timeZone: ctx.timezone })}`,
    "Relatório completo na tela Mercado.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function registerMarket(api: Hono<AppEnv>) {
  api.get("/market-studies", async (c) => {
    const ctx = c.get("ctx");
    const q = c.req.query("q")?.trim();
    const p = q ? likePattern(q) : null;
    const rows = await ctx.db
      .select({ ...listColumns, hasState: sql<number>`${marketStudies.stateGz} is not null` })
      .from(marketStudies)
      .where(
        and(
          eq(marketStudies.workspaceId, ctx.workspaceId),
          p ? or(sql`${marketStudies.address} LIKE ${p} ESCAPE '\\'`, sql`${marketStudies.city} LIKE ${p} ESCAPE '\\'`) : undefined,
        ),
      )
      .orderBy(desc(marketStudies.analyzedAt))
      .limit(500);
    return c.json(rows.map((r) => serialize({ ...r, hasState: !!r.hasState })));
  });

  api.get("/market-studies/:id", async (c) => c.json(serialize(await getStudy(c.get("ctx"), c.req.param("id")))));

  api.post("/market-studies", async (c) => {
    const ctx = c.get("ctx");
    const { analyzedAt, ...body } = await parseBody(c, studyCreate);
    const row = { id: newId(), workspaceId: ctx.workspaceId, createdBy: ctx.userId, analyzedAt: Date.parse(analyzedAt), ...body };
    const { stateGz, ...summary } = body;
    await ctx.db.batch([
      ctx.db.insert(marketStudies).values(row),
      auditInsert(ctx, "market_study", row.id, "create", null, { ...summary, analyzedAt, stateBytes: stateGz?.length ?? 0 }),
    ]);
    const { stateGz: _s, ...saved } = await getStudy(ctx, row.id);
    return c.json(serialize({ ...saved, hasState: !!stateGz }), 201);
  });

  api.delete("/market-studies/:id", async (c) => {
    const ctx = c.get("ctx");
    requireRole(ctx, "owner", "admin");
    const { stateGz: _s, ...before } = await getStudy(ctx, c.req.param("id"));
    await ctx.db.batch([
      ctx.db.delete(marketStudies).where(and(eq(marketStudies.id, before.id), eq(marketStudies.workspaceId, ctx.workspaceId))),
      auditInsert(ctx, "market_study", before.id, "delete", before, null),
    ]);
    return c.body(null, 204);
  });

  /** Abre um projeto para tocar a negociação do ponto, com o resumo do estudo na descrição. */
  api.post("/market-studies/:id/project", async (c) => {
    const ctx = c.get("ctx");
    const study = await getStudy(ctx, c.req.param("id"));
    if (study.projectId) return c.json({ error: "este estudo já tem um projeto", projectId: study.projectId }, 409);
    const body = await parseBody(c, studyProject);
    const projectId = newId();
    const project = {
      id: projectId,
      workspaceId: ctx.workspaceId,
      title: `Ponto Omega: ${study.address}`.slice(0, 200),
      description: projectDescription(ctx, study),
      priority: body.priority,
      createdBy: ctx.userId,
    };
    // A condição project_id is null evita dois projetos para o mesmo estudo em cliques simultâneos.
    const [, updated] = await ctx.db.batch([
      ctx.db.insert(projects).values(project),
      ctx.db
        .update(marketStudies)
        .set({ projectId, updatedAt: Date.now() })
        .where(and(eq(marketStudies.id, study.id), eq(marketStudies.workspaceId, ctx.workspaceId), isNull(marketStudies.projectId))),
      auditInsert(ctx, "project", projectId, "create", null, { title: project.title, sourceMarketStudyId: study.id }),
      auditInsert(ctx, "market_study", study.id, "update", { projectId: null }, { projectId }),
    ]);
    if (updated.meta.changes === 0) {
      // Outra requisição criou o projeto antes: desfaz o que esta gravou.
      await ctx.db.batch([
        ctx.db.delete(projects).where(eq(projects.id, projectId)),
        ctx.db
          .delete(auditLog)
          .where(or(eq(auditLog.entityId, projectId), and(eq(auditLog.entityId, study.id), sql`json_extract(${auditLog.after}, '$.projectId') = ${projectId}`))),
      ]);
      return c.json({ error: "este estudo já tem um projeto" }, 409);
    }
    const created = await ctx.db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    return c.json(serialize(created!), 201);
  });
}
