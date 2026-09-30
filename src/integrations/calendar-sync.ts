import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLog, calendars, events, integrationAccounts, syncJobs, workspaces } from "../db/schema";
import type { Env } from "../env";
import { newId } from "../lib/crypto";
import { recordError } from "../lib/log";
import { fromGoogleRecurrence, seriesEnd, toGoogleRecurrence } from "../lib/recurrence";
import { parseDateTime } from "../lib/time";
import { decryptSecret, encryptSecret } from "../lib/secret";
import { GoogleClient, GoogleError, googleFetch, refreshAccessToken, type GoogleEvent } from "./google-client";

type Account = typeof integrationAccounts.$inferSelect;
type Calendar = typeof calendars.$inferSelect;
type LocalEvent = typeof events.$inferSelect;

export interface SyncDeps {
  db: Db;
  env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "TOKEN_ENCRYPTION_KEY">;
  fetcher?: typeof fetch;
  now?: () => number;
}

export const MAX_ATTEMPTS = 8;
/** Janela do sync inicial: eventos que terminam a partir de 30 dias atrás. */
const INITIAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Id do evento no Google derivado do id local: repetir o insert não duplica (Google devolve 409). */
export function googleIdFor(localId: string) {
  return localId.replace(/-/g, "").toLowerCase();
}

export function backoffMs(attempts: number) {
  return Math.min(60_000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000);
}

// ---------- Tokens ----------

async function markAccount(deps: SyncDeps, account: Account, status: Account["status"], error: string | null) {
  await deps.db
    .update(integrationAccounts)
    .set({ status, lastError: error, updatedAt: Date.now() })
    .where(eq(integrationAccounts.id, account.id));
}

/** Access token válido; renova com o refresh token quando preciso. */
export async function accessTokenFor(deps: SyncDeps, account: Account): Promise<string> {
  const key = deps.env.TOKEN_ENCRYPTION_KEY;
  const now = deps.now?.() ?? Date.now();
  if (account.accessTokenEnc && account.accessTokenExpiresAt && account.accessTokenExpiresAt > now) {
    return decryptSecret(account.accessTokenEnc, key);
  }
  try {
    const { accessToken, expiresAt } = await refreshAccessToken({
      refreshToken: await decryptSecret(account.refreshTokenEnc, key),
      clientId: deps.env.GOOGLE_CLIENT_ID,
      clientSecret: deps.env.GOOGLE_CLIENT_SECRET,
      fetcher: deps.fetcher,
    });
    const accessTokenEnc = await encryptSecret(accessToken, key);
    await deps.db
      .update(integrationAccounts)
      .set({ accessTokenEnc, accessTokenExpiresAt: expiresAt, updatedAt: Date.now() })
      .where(eq(integrationAccounts.id, account.id));
    account.accessTokenEnc = accessTokenEnc;
    account.accessTokenExpiresAt = expiresAt;
    return accessToken;
  } catch (e) {
    if (e instanceof GoogleError && e.revoked) {
      await markAccount(deps, account, "revoked", "O acesso ao Google foi revogado. Conecte de novo.");
    }
    throw e;
  }
}

/** Cliente do Google Agenda com token válido. */
export async function clientFor(deps: SyncDeps, account: Account): Promise<GoogleClient> {
  return new GoogleClient(await accessTokenFor(deps, account), deps.fetcher ?? googleFetch.impl);
}

// ---------- Agendas ----------

export async function refreshCalendarList(deps: SyncDeps, account: Account) {
  const client = await clientFor(deps, account);
  const list = await client.listCalendars();
  const existing = await deps.db.select().from(calendars).where(eq(calendars.accountId, account.id));
  const firstTime = existing.length === 0;
  for (const c of list) {
    const writable = c.accessRole === "owner" || c.accessRole === "writer";
    await deps.db
      .insert(calendars)
      .values({
        id: newId(),
        workspaceId: account.workspaceId,
        accountId: account.id,
        googleCalendarId: c.id,
        summary: c.summary,
        primary: !!c.primary,
        writable,
        // Na primeira conexão só a agenda principal entra na sincronização.
        selected: firstTime && !!c.primary,
      })
      .onConflictDoUpdate({
        target: [calendars.accountId, calendars.googleCalendarId],
        set: { summary: c.summary, primary: !!c.primary, writable, updatedAt: Date.now() },
      });
  }
  if (firstTime && !account.defaultCalendarId) {
    const primary = list.find((c) => c.primary);
    if (primary) {
      await deps.db.update(integrationAccounts).set({ defaultCalendarId: primary.id }).where(eq(integrationAccounts.id, account.id));
      account.defaultCalendarId = primary.id;
    }
  }
}

// ---------- Google → Central ----------

function toLocalTimes(ev: GoogleEvent, timeZone: string) {
  if (ev.start?.dateTime && ev.end?.dateTime) {
    return { startAt: Date.parse(ev.start.dateTime), endAt: Date.parse(ev.end.dateTime), allDay: false };
  }
  if (ev.start?.date && ev.end?.date) {
    return { startAt: parseDateTime(ev.start.date, timeZone)!, endAt: parseDateTime(ev.end.date, timeZone)!, allDay: true };
  }
  return null;
}

async function hasPendingJob(db: Db, eventId: string) {
  const row = await db
    .select({ id: syncJobs.id })
    .from(syncJobs)
    .where(and(eq(syncJobs.eventId, eventId), eq(syncJobs.status, "pending")))
    .get();
  return !!row;
}

function remoteReminder(ev: GoogleEvent): number | null | undefined {
  const popup = ev.reminders?.overrides?.filter((r) => r.method === "popup").map((r) => r.minutes);
  if (popup?.length) return Math.min(...popup);
  // Lembrete padrão do Google: mantém o que a Central tiver.
  return undefined;
}

function originalStart(ev: GoogleEvent, timeZone: string) {
  const o = ev.originalStartTime;
  if (o?.dateTime) return Date.parse(o.dateTime);
  if (o?.date) return parseDateTime(o.date, o.timeZone ?? timeZone);
  return null;
}

/** Aplica um evento do Google. Devolve "defer" quando é exceção de uma série que ainda não chegou. */
async function applyRemoteEvent(deps: SyncDeps, cal: Calendar, timeZone: string, ev: GoogleEvent): Promise<"ok" | "defer"> {
  const { db } = deps;
  const local = await db.query.events.findFirst({
    where: and(eq(events.workspaceId, cal.workspaceId), eq(events.calendarId, cal.googleCalendarId), eq(events.remoteId, ev.id)),
  });
  // Alteração local ainda na fila vence: ela será enviada ao Google em seguida.
  if (local && (await hasPendingJob(db, local.id))) return "ok";

  const master = ev.recurringEventId
    ? await db.query.events.findFirst({
        where: and(eq(events.workspaceId, cal.workspaceId), eq(events.calendarId, cal.googleCalendarId), eq(events.remoteId, ev.recurringEventId)),
      })
    : undefined;
  const original = ev.recurringEventId ? originalStart(ev, timeZone) : null;

  if (ev.status === "cancelled") {
    if (local) {
      await db.batch([
        db.delete(events).where(eq(events.id, local.id)),
        db.insert(auditLog).values({ id: newId(), workspaceId: cal.workspaceId, entity: "event", entityId: local.id, action: "delete", before: local, after: { via: "google" } }),
      ]);
    }
    if (ev.recurringEventId && original != null) {
      // Ocorrência apagada no Google: vira data excluída da série.
      if (!master) return "defer";
      const exdates = master.exdates ?? [];
      if (!exdates.includes(original) && !(await hasPendingJob(db, master.id))) {
        await db.update(events).set({ exdates: [...exdates, original], updatedAt: Date.now() }).where(eq(events.id, master.id));
      }
    }
    return "ok";
  }

  const times = toLocalTimes(ev, timeZone);
  if (!times) return "ok";
  const tz = ev.start?.timeZone ?? timeZone;
  const series = ev.recurrence ? fromGoogleRecurrence(ev.recurrence, tz) : null;
  const reminder = remoteReminder(ev);
  const values = {
    title: ev.summary?.trim() || "(sem título)",
    description: ev.description ?? null,
    ...times,
    timezone: tz,
    recurrence: series?.recurrence ?? null,
    exdates: series?.exdates.length ? series.exdates : null,
    recurrenceEndsAt: series ? seriesEnd({ ...times, timezone: tz, recurrence: series.recurrence }) : null,
    seriesId: master?.id ?? null,
    originalStartAt: original,
    ...(reminder !== undefined && { reminderMinutes: reminder }),
    syncStatus: "synced" as const,
  };
  if (local) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = (Object.keys(values) as (keyof typeof values)[]).some((k) => k !== "syncStatus" && !same(values[k], local[k as keyof LocalEvent]));
    if (!changed) {
      if (local.syncStatus !== "synced") await db.update(events).set({ syncStatus: "synced" }).where(eq(events.id, local.id));
      return "ok";
    }
    await db.batch([
      db.update(events).set({ ...values, updatedAt: Date.now() }).where(eq(events.id, local.id)),
      db.insert(auditLog).values({
        id: newId(),
        workspaceId: cal.workspaceId,
        entity: "event",
        entityId: local.id,
        action: "update",
        before: { title: local.title, startAt: local.startAt, endAt: local.endAt, recurrence: local.recurrence },
        after: { ...values, via: "google" },
      }),
    ]);
  } else {
    const id = newId();
    await db.batch([
      db.insert(events).values({ id, workspaceId: cal.workspaceId, calendarId: cal.googleCalendarId, remoteId: ev.id, ...values }),
      db.insert(auditLog).values({ id: newId(), workspaceId: cal.workspaceId, entity: "event", entityId: id, action: "create", before: null, after: { ...values, via: "google" } }),
      // Exceções que chegaram antes da série passam a apontar para ela.
      ...(series
        ? [
            db
              .update(events)
              .set({ seriesId: id })
              .where(and(eq(events.workspaceId, cal.workspaceId), eq(events.calendarId, cal.googleCalendarId), sql`${events.remoteId} LIKE ${`${ev.id}\\_%`} ESCAPE '\\'`, sql`${events.seriesId} IS NULL`)),
          ]
        : []),
    ]);
  }
  return "ok";
}

/** Sync de uma agenda: inicial paginado, depois incremental com syncToken; 410 reconstrói do zero. */
export async function syncCalendar(deps: SyncDeps, account: Account, cal: Calendar) {
  const client = await clientFor(deps, account);
  const ws = await deps.db.query.workspaces.findFirst({ where: eq(workspaces.id, cal.workspaceId) });
  const timeZone = ws?.timezone ?? "America/Sao_Paulo";
  let syncToken = cal.syncToken;
  let pageToken: string | undefined;
  const timeMin = new Date((deps.now?.() ?? Date.now()) - INITIAL_WINDOW_MS).toISOString();
  let applied = 0;
  const deferred: GoogleEvent[] = [];

  for (;;) {
    let page;
    try {
      page = await client.listEvents(cal.googleCalendarId, { syncToken, timeMin, pageToken });
    } catch (e) {
      if (e instanceof GoogleError && e.status === 410 && syncToken) {
        // Token inválido: recomeça com sync completo.
        syncToken = null;
        pageToken = undefined;
        continue;
      }
      throw e;
    }
    // Séries primeiro, para as exceções da mesma página já acharem o mestre.
    const items = [...(page.items ?? [])].sort((a, b) => Number(!!a.recurringEventId) - Number(!!b.recurringEventId));
    for (const ev of items) {
      if ((await applyRemoteEvent(deps, cal, timeZone, ev)) === "defer") deferred.push(ev);
      applied++;
    }
    if (page.nextPageToken) {
      pageToken = page.nextPageToken;
      continue;
    }
    await deps.db
      .update(calendars)
      .set({ syncToken: page.nextSyncToken ?? null, updatedAt: Date.now() })
      .where(eq(calendars.id, cal.id));
    // Exceções cuja série veio numa página posterior.
    for (const ev of deferred) await applyRemoteEvent(deps, cal, timeZone, ev);
    return applied;
  }
}

// ---------- Central → Google ----------

/**
 * Comandos que colocam na fila o envio de um compromisso, para rodar no mesmo batch da
 * gravação local (atômico). Uma única tarefa pendente por evento: edições seguidas se
 * juntam e a fila envia o estado mais recente. Sem conta Google ativa, devolve [].
 */
export async function enqueueStatements(
  db: Db,
  workspaceId: string,
  event: Pick<LocalEvent, "id" | "calendarId" | "remoteId">,
  kind: "event.upsert" | "event.delete",
): Promise<any[]> {
  const account = await db.query.integrationAccounts.findFirst({
    where: and(eq(integrationAccounts.workspaceId, workspaceId), eq(integrationAccounts.status, "active")),
  });
  if (!account) return [];
  const calendarId = event.calendarId ?? account.defaultCalendarId;
  if (!calendarId) return [];
  // Agendas só de leitura (ex.: feriados) não recebem alterações: a mudança fica só na Central.
  const target = await db.query.calendars.findFirst({
    where: and(eq(calendars.accountId, account.id), eq(calendars.googleCalendarId, calendarId)),
  });
  if (target && !target.writable) return [];
  if (kind === "event.delete" && !event.remoteId) {
    // Nunca chegou ao Google: basta descartar o que estiver na fila.
    return [db.delete(syncJobs).where(and(eq(syncJobs.eventId, event.id), eq(syncJobs.status, "pending")))];
  }
  const now = Date.now();
  const payload = { calendarId, remoteId: event.remoteId ?? undefined };
  const stmts: any[] = [
    db
      .insert(syncJobs)
      .values({ id: newId(), workspaceId, kind, eventId: event.id, payload, idempotencyKey: `event:${event.id}`, nextAttemptAt: now })
      .onConflictDoUpdate({
        target: syncJobs.idempotencyKey,
        set: { kind, payload, attempts: 0, nextAttemptAt: now, error: null, status: "pending", updatedAt: now },
      }),
  ];
  if (kind === "event.upsert") {
    stmts.push(db.update(events).set({ calendarId, syncStatus: "pending" }).where(eq(events.id, event.id)));
  }
  return stmts;
}

function toGoogle(ev: LocalEvent): GoogleEvent {
  const date = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: ev.timezone });
  return {
    id: googleIdFor(ev.id),
    summary: ev.title,
    description: ev.description ?? undefined,
    start: ev.allDay ? { date: date(ev.startAt) } : { dateTime: new Date(ev.startAt).toISOString(), timeZone: ev.timezone },
    end: ev.allDay ? { date: date(ev.endAt) } : { dateTime: new Date(ev.endAt).toISOString(), timeZone: ev.timezone },
    // Sem regra, [] remove a repetição no Google ao editar.
    recurrence: ev.recurrence ? toGoogleRecurrence({ ...ev, recurrence: ev.recurrence }) : [],
    reminders: ev.reminderMinutes != null ? { useDefault: false, overrides: [{ method: "popup", minutes: ev.reminderMinutes }] } : { useDefault: true },
  };
}

async function finishJob(db: Db, job: typeof syncJobs.$inferSelect, extra: any[] = []) {
  // Libera a chave de idempotência para a próxima alteração do mesmo evento.
  await db.batch([
    db
      .update(syncJobs)
      .set({ status: "done", idempotencyKey: `${job.idempotencyKey}:done:${job.id}`, error: null, updatedAt: Date.now() })
      .where(eq(syncJobs.id, job.id)),
    ...extra,
  ] as [any, ...any[]]);
}

async function runJob(deps: SyncDeps, client: GoogleClient, job: typeof syncJobs.$inferSelect) {
  const { db } = deps;
  const calendarId = job.payload?.calendarId;
  if (!calendarId) throw new GoogleError(400, "noCalendar", "Sem agenda de destino");

  if (job.kind === "event.delete") {
    try {
      await client.deleteEvent(calendarId, job.payload!.remoteId!);
    } catch (e) {
      // Já não existe no Google: objetivo atingido.
      if (!(e instanceof GoogleError && (e.status === 404 || e.status === 410))) throw e;
    }
    await finishJob(db, job);
    return;
  }

  const ev = await db.query.events.findFirst({ where: eq(events.id, job.eventId) });
  if (!ev) {
    await finishJob(db, job);
    return;
  }
  const body = toGoogle(ev);
  let saved: GoogleEvent;
  if (ev.remoteId) {
    const { id: _id, ...patch } = body;
    saved = await client.patchEvent(calendarId, ev.remoteId, patch);
  } else {
    try {
      saved = await client.insertEvent(calendarId, body);
    } catch (e) {
      // 409: um envio anterior chegou ao Google mas a resposta se perdeu. Atualiza o mesmo id.
      if (!(e instanceof GoogleError && e.status === 409)) throw e;
      const { id: _id, ...patch } = body;
      saved = await client.patchEvent(calendarId, body.id, patch);
    }
  }
  // Só marca como sincronizado depois da resposta do Google e do vínculo gravado.
  await finishJob(db, job, [
    db.update(events).set({ remoteId: saved.id, calendarId, syncStatus: "synced" }).where(eq(events.id, ev.id)),
  ]);
}

/** Processa a fila de envio. Falhas transitórias voltam com backoff; as permanentes marcam erro. */
export async function processJobs(deps: SyncDeps, opts: { workspaceId?: string; eventId?: string; limit?: number } = {}) {
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();
  const jobs = await db
    .select()
    .from(syncJobs)
    .where(
      and(
        eq(syncJobs.status, "pending"),
        lte(syncJobs.nextAttemptAt, now),
        opts.workspaceId ? eq(syncJobs.workspaceId, opts.workspaceId) : undefined,
        opts.eventId ? eq(syncJobs.eventId, opts.eventId) : undefined,
      ),
    )
    .orderBy(syncJobs.nextAttemptAt)
    .limit(opts.limit ?? 50);

  const clients = new Map<string, GoogleClient | null>();
  const result = { done: 0, retried: 0, failed: 0 };
  for (const job of jobs) {
    if (!clients.has(job.workspaceId)) {
      const account = await db.query.integrationAccounts.findFirst({
        where: and(eq(integrationAccounts.workspaceId, job.workspaceId), eq(integrationAccounts.status, "active")),
      });
      clients.set(job.workspaceId, account ? await clientFor(deps, account).catch(() => null) : null);
    }
    const client = clients.get(job.workspaceId);
    if (!client) continue; // Conta desconectada ou revogada: a tarefa espera a reconexão.
    try {
      await runJob(deps, client, job);
      result.done++;
    } catch (e) {
      const err = e instanceof GoogleError ? e : new GoogleError(0, "unknown", (e as Error).message);
      const attempts = job.attempts + 1;
      if (err.revoked) {
        const account = await db.query.integrationAccounts.findFirst({ where: eq(integrationAccounts.workspaceId, job.workspaceId) });
        if (account) await markAccount(deps, account, "revoked", "O acesso ao Google foi revogado. Conecte de novo.");
        clients.set(job.workspaceId, null);
        await db.update(syncJobs).set({ attempts, error: err.message, updatedAt: Date.now() }).where(eq(syncJobs.id, job.id));
        result.retried++;
      } else if (err.transient && attempts < MAX_ATTEMPTS) {
        await db
          .update(syncJobs)
          .set({ attempts, error: err.message, nextAttemptAt: now + backoffMs(attempts), updatedAt: Date.now() })
          .where(eq(syncJobs.id, job.id));
        result.retried++;
      } else {
        await db.batch([
          db
            .update(syncJobs)
            .set({ status: "failed", attempts, error: err.message, idempotencyKey: `${job.idempotencyKey}:failed:${job.id}`, updatedAt: Date.now() })
            .where(eq(syncJobs.id, job.id)),
          db.update(events).set({ syncStatus: "error" }).where(eq(events.id, job.eventId)),
        ]);
        result.failed++;
      }
    }
  }
  return result;
}

// ---------- Rodada completa ----------

/** Envia a fila e traz as mudanças das agendas selecionadas. Usado pelo cron e pelo botão "Sincronizar". */
export async function syncWorkspace(deps: SyncDeps, workspaceId: string) {
  const account = await deps.db.query.integrationAccounts.findFirst({
    where: and(eq(integrationAccounts.workspaceId, workspaceId), eq(integrationAccounts.status, "active")),
  });
  if (!account) return { jobs: { done: 0, retried: 0, failed: 0 }, imported: 0 };
  const jobs = await processJobs(deps, { workspaceId });
  let imported = 0;
  try {
    const selected = await deps.db
      .select()
      .from(calendars)
      .where(and(eq(calendars.accountId, account.id), eq(calendars.selected, true)));
    for (const cal of selected) imported += await syncCalendar(deps, account, cal);
    await deps.db
      .update(integrationAccounts)
      .set({ lastSyncAt: Date.now(), lastError: null, updatedAt: Date.now() })
      .where(and(eq(integrationAccounts.id, account.id), eq(integrationAccounts.status, "active")));
  } catch (e) {
    const msg = e instanceof GoogleError ? e.message : "Falha ao sincronizar";
    if (!(e instanceof GoogleError && e.revoked)) await markAccount(deps, account, e instanceof GoogleError && e.transient ? "active" : "error", msg);
    throw e;
  }
  return { jobs, imported };
}

export async function syncAll(deps: SyncDeps) {
  const accounts = await deps.db
    .select({ workspaceId: integrationAccounts.workspaceId })
    .from(integrationAccounts)
    .where(eq(integrationAccounts.status, "active"));
  for (const a of accounts) {
    await syncWorkspace(deps, a.workspaceId).catch((e) => recordError(deps.db, `sync ${a.workspaceId}`, e));
  }
}

export async function jobCounts(db: Db, workspaceId: string) {
  const rows = await db
    .select({ status: syncJobs.status, n: sql<number>`count(*)` })
    .from(syncJobs)
    .where(and(eq(syncJobs.workspaceId, workspaceId), inArray(syncJobs.status, ["pending", "failed"])))
    .groupBy(syncJobs.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as { pending?: number; failed?: number };
}
