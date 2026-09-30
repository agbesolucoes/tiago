import { and, eq } from "drizzle-orm";
import { attachments, events } from "../db/schema";
import { enqueueStatements } from "../integrations/calendar-sync";
import type { EventRow } from "../lib/occurrences";
import type { RequestContext } from "./context";
import { auditInsert } from "./helpers";

/**
 * Comandos para excluir um compromisso num único batch, com o envio ao Google na fila.
 * Numa série, exclui a série inteira; numa ocorrência avulsa, a data continua fora da série.
 */
export async function deleteEventStatements(ctx: RequestContext, before: EventRow): Promise<any[]> {
  const stmts: any[] = [...(await enqueueStatements(ctx.db, ctx.workspaceId, before, "event.delete"))];
  if (before.recurrence) {
    // Ocorrências avulsas criadas aqui são eventos próprios no Google; as que vieram do Google somem com a série.
    const detached = await ctx.db.select().from(events).where(and(eq(events.workspaceId, ctx.workspaceId), eq(events.seriesId, before.id)));
    for (const d of detached) {
      if (before.remoteId && d.remoteId?.startsWith(`${before.remoteId}_`)) continue;
      stmts.push(...(await enqueueStatements(ctx.db, ctx.workspaceId, d, "event.delete")));
    }
  }
  if (before.seriesId && before.originalStartAt != null) {
    const master = await ctx.db.query.events.findFirst({ where: and(eq(events.id, before.seriesId), eq(events.workspaceId, ctx.workspaceId)) });
    if (master && !(master.exdates ?? []).includes(before.originalStartAt)) {
      stmts.push(ctx.db.update(events).set({ exdates: [...(master.exdates ?? []), before.originalStartAt], updatedAt: Date.now() }).where(eq(events.id, master.id)));
      stmts.push(...(await enqueueStatements(ctx.db, ctx.workspaceId, master, "event.upsert")));
    }
  }
  return [
    ctx.db.delete(events).where(and(eq(events.id, before.id), eq(events.workspaceId, ctx.workspaceId))),
    auditInsert(ctx, "event", before.id, "delete", before, null),
    ctx.db.delete(attachments).where(and(eq(attachments.workspaceId, ctx.workspaceId), eq(attachments.parentKind, "event"), eq(attachments.parentId, before.id))),
    ...stmts,
  ];
}
