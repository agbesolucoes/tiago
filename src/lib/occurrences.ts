import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { events } from "../db/schema";
import { expand, fromRRule, type Repeat } from "./recurrence";
import { toIso } from "./time";

export type EventRow = typeof events.$inferSelect;

/** Um compromisso como aparece na agenda: evento simples, exceção ou ocorrência de uma série. */
export interface Occurrence extends EventRow {
  /** Início original da ocorrência (igual a startAt, exceto em exceções remarcadas). */
  occurrenceStart: number;
  /** Série a que pertence (o próprio id para ocorrências do mestre). */
  seriesId: string | null;
  recurring: boolean;
  /** Início e fim da primeira ocorrência da série (para editar a série a partir de uma ocorrência). */
  seriesStartAt?: number;
  seriesEndAt?: number;
}

const LIMIT = 2000;

/**
 * Compromissos que se sobrepõem a [from, to), com as séries expandidas.
 * `where` filtra mais (busca por texto etc.).
 */
export async function listOccurrences(db: Db, workspaceId: string, from: number, to: number, where?: SQL): Promise<Occurrence[]> {
  const [single, masters] = await db.batch([
    db
      .select()
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), isNull(events.recurrence), lt(events.startAt, to), gt(events.endAt, from), where))
      .orderBy(asc(events.startAt))
      .limit(LIMIT),
    db
      .select()
      .from(events)
      .where(
        and(
          eq(events.workspaceId, workspaceId),
          isNotNull(events.recurrence),
          lt(events.startAt, to),
          or(isNull(events.recurrenceEndsAt), gt(events.recurrenceEndsAt, from)),
          where,
        ),
      )
      .limit(LIMIT),
  ]);
  const out: Occurrence[] = single.map((e) => ({ ...e, occurrenceStart: e.originalStartAt ?? e.startAt, recurring: !!e.seriesId }));
  if (masters.length) {
    // Exceções substituem a ocorrência original, mesmo se foram remarcadas para fora do intervalo.
    const exceptions = await db
      .select({ seriesId: events.seriesId, originalStartAt: events.originalStartAt })
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), inArray(events.seriesId, masters.map((m) => m.id))));
    for (const m of masters) {
      const skip = new Set(exceptions.filter((x) => x.seriesId === m.id && x.originalStartAt != null).map((x) => x.originalStartAt!));
      for (const o of expand({ ...m, recurrence: m.recurrence! }, from, to, skip)) {
        out.push({ ...m, startAt: o.start, endAt: o.end, occurrenceStart: o.start, seriesId: m.id, recurring: true, seriesStartAt: m.startAt, seriesEndAt: m.endAt });
      }
    }
  }
  return out.sort((a, b) => a.startAt - b.startAt || a.title.localeCompare(b.title)).slice(0, LIMIT);
}

/** Resposta da API para um compromisso (ou ocorrência). */
export function eventView(e: EventRow | Occurrence) {
  const { exdates, ...rest } = e;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    out[k] = ["createdAt", "updatedAt", "startAt", "endAt", "originalStartAt", "recurrenceEndsAt", "occurrenceStart", "seriesStartAt", "seriesEndAt"].includes(k) ? toIso(v as number | null) : v;
  }
  const repeat: Repeat | null = e.recurrence ? fromRRule(e.recurrence, e.timezone) : null;
  return {
    ...out,
    seriesId: "seriesId" in e ? e.seriesId : null,
    recurring: "recurring" in e ? e.recurring : !!(e.recurrence || e.seriesId),
    repeat,
    customRepeat: !!e.recurrence && !repeat,
    exdates: (exdates ?? []).map((ms) => toIso(ms)),
  };
}

