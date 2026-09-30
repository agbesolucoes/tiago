import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { attachmentParents, attachments, events, ideas, integrationAccounts, projects, tasks } from "../db/schema";
import { DriveUnavailable, driveFor, ensureFolders, folderKeyFor, uploadToDrive } from "../integrations/drive";
import { GoogleError, type DriveFile } from "../integrations/google-client";
import { newId } from "../lib/crypto";
import { requireMember, type AppEnv, type RequestContext } from "./context";
import { auditInsert, ensureRef, notFound, parseBody, serialize, ValidationError } from "./helpers";

export const attachmentsApi = new Hono<AppEnv>();
attachmentsApi.use("*", requireMember);

/** Limite por arquivo (o Workers aceita corpos de até 100 MB no plano gratuito). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const parentKind = z.enum(attachmentParents);
type ParentKind = z.infer<typeof parentKind>;

async function checkParent(ctx: RequestContext, kind: ParentKind, id: string | null | undefined) {
  if (kind === "general") {
    if (id) throw new ValidationError([{ path: "parentId", message: "documentos gerais não têm registro" }]);
    return { taskHasProject: false };
  }
  if (!id) throw new ValidationError([{ path: "parentId", message: "obrigatório" }]);
  const table = { project: projects, task: tasks, event: events, idea: ideas }[kind];
  await ensureRef(ctx, table, id, "parentId");
  if (kind === "task") {
    const t = await ctx.db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    return { taskHasProject: !!t?.projectId };
  }
  return { taskHasProject: false };
}

async function activeAccount(ctx: RequestContext) {
  const account = await ctx.db.query.integrationAccounts.findFirst({
    where: and(eq(integrationAccounts.workspaceId, ctx.workspaceId), eq(integrationAccounts.provider, "google")),
  });
  if (!account) throw new HTTPException(409, { message: "Conecte o Google em Configurações para usar o Drive." });
  return account;
}

function driveError(e: unknown): never {
  if (e instanceof DriveUnavailable) throw new HTTPException(409, { message: e.message });
  if (e instanceof GoogleError) {
    if (e.status === 404) throw new ValidationError([{ path: "driveFileId", message: "arquivo não encontrado ou sem acesso; escolha pelo seletor do Drive" }]);
    throw new HTTPException(502, { message: `O Google Drive recusou: ${e.message}` });
  }
  throw e;
}

async function save(ctx: RequestContext, kind: ParentKind, parentId: string | null, file: DriveFile, origin: "uploaded" | "linked") {
  const row = {
    id: newId(),
    workspaceId: ctx.workspaceId,
    parentKind: kind,
    parentId,
    driveFileId: file.id,
    name: file.name,
    mimeType: file.mimeType ?? null,
    size: file.size ? Number(file.size) : null,
    webViewLink: file.webViewLink ?? null,
    origin,
    createdBy: ctx.userId,
  };
  const dup = await ctx.db.query.attachments.findFirst({
    where: and(
      eq(attachments.workspaceId, ctx.workspaceId),
      eq(attachments.driveFileId, file.id),
      eq(attachments.parentKind, kind),
      parentId ? eq(attachments.parentId, parentId) : isNull(attachments.parentId),
    ),
  });
  if (dup) return dup;
  // O vínculo só é gravado depois da resposta do Google.
  await ctx.db.batch([ctx.db.insert(attachments).values(row), auditInsert(ctx, "attachment", row.id, "create", null, { name: row.name, driveFileId: row.driveFileId, parentKind: kind, parentId, origin })]);
  return row;
}

attachmentsApi.get("/", async (c) => {
  const ctx = c.get("ctx");
  const kind = parentKind.safeParse(c.req.query("parentKind"));
  if (!kind.success) throw new ValidationError([{ path: "parentKind", message: "valor inválido" }]);
  const parentId = c.req.query("parentId") || null;
  const rows = await ctx.db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.workspaceId, ctx.workspaceId),
        eq(attachments.parentKind, kind.data),
        parentId ? eq(attachments.parentId, parentId) : isNull(attachments.parentId),
      ),
    )
    .orderBy(desc(attachments.createdAt));
  return c.json(rows.map(serialize));
});

/** Upload em streaming: o corpo da requisição vai direto para a sessão de upload do Drive. */
attachmentsApi.post("/upload", async (c) => {
  const ctx = c.get("ctx");
  const kind = parentKind.safeParse(c.req.query("parentKind"));
  if (!kind.success) throw new ValidationError([{ path: "parentKind", message: "valor inválido" }]);
  const parentId = c.req.query("parentId") || null;
  const name = (c.req.query("name") ?? "").trim().slice(0, 255);
  if (!name) throw new ValidationError([{ path: "name", message: "nome do arquivo obrigatório" }]);
  const size = Number(c.req.header("content-length"));
  if (!Number.isFinite(size) || size <= 0) throw new ValidationError([{ path: "file", message: "arquivo vazio ou sem tamanho" }]);
  if (size > MAX_UPLOAD_BYTES) throw new ValidationError([{ path: "file", message: "arquivo maior que 100 MB" }]);
  const body = c.req.raw.body;
  if (!body) throw new ValidationError([{ path: "file", message: "arquivo ausente" }]);

  const { taskHasProject } = await checkParent(ctx, kind.data, parentId);
  const account = await activeAccount(ctx);
  const mimeType = c.req.header("content-type") || "application/octet-stream";
  // FixedLengthStream mantém o Content-Length sem carregar o arquivo na memória.
  const { readable, writable } = new FixedLengthStream(size);
  const piping = body.pipeTo(writable).catch(() => {});
  let file: DriveFile;
  try {
    file = await uploadToDrive({ db: ctx.db, env: c.env }, account, { name, mimeType, size, body: readable, folder: folderKeyFor(kind.data, taskHasProject) });
    await piping;
  } catch (e) {
    // Ninguém vai ler o resto do arquivo: encerra o fluxo para não travar a requisição.
    await readable.cancel().catch(() => {});
    driveError(e);
  }
  return c.json(serialize(await save(ctx, kind.data, parentId, file!, "uploaded")), 201);
});

const linkBody = z.strictObject({
  parentKind,
  parentId: z.string().min(1).nullable().optional(),
  driveFileId: z.string().min(1).max(200),
});

/** Vincula um arquivo escolhido no Picker. Com drive.file o Google só libera arquivos escolhidos pela pessoa. */
attachmentsApi.post("/link", async (c) => {
  const ctx = c.get("ctx");
  const body = await parseBody(c, linkBody);
  await checkParent(ctx, body.parentKind, body.parentId);
  const account = await activeAccount(ctx);
  let file: DriveFile;
  try {
    file = await (await driveFor({ db: ctx.db, env: c.env }, account)).getFile(body.driveFileId);
  } catch (e) {
    driveError(e);
  }
  if (file!.trashed) throw new ValidationError([{ path: "driveFileId", message: "o arquivo está na lixeira do Drive" }]);
  return c.json(serialize(await save(ctx, body.parentKind, body.parentId ?? null, file!, "linked")), 201);
});

/** Remove só o vínculo. O arquivo continua no Drive. */
attachmentsApi.delete("/:id", async (c) => {
  const ctx = c.get("ctx");
  const row = await ctx.db.query.attachments.findFirst({
    where: and(eq(attachments.id, c.req.param("id")), eq(attachments.workspaceId, ctx.workspaceId)),
  });
  if (!row) notFound();
  await ctx.db.batch([ctx.db.delete(attachments).where(eq(attachments.id, row.id)), auditInsert(ctx, "attachment", row.id, "delete", row, null)]);
  return c.body(null, 204);
});

/** Garante as pastas e devolve o link da pasta principal. */
attachmentsApi.post("/folders", async (c) => {
  const ctx = c.get("ctx");
  const account = await activeAccount(ctx);
  try {
    const folders = await ensureFolders({ db: ctx.db, env: c.env }, account);
    return c.json({ folders, rootUrl: `https://drive.google.com/drive/folders/${folders.root}` });
  } catch (e) {
    driveError(e);
  }
});
