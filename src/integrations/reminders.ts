import { and, between, eq, isNotNull, lt, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { memberships, pushSubscriptions, reminderLog, tasks, telegramLinks, workspaces } from "../db/schema";
import type { Env } from "../env";
import { recordError } from "../lib/log";
import { listOccurrences } from "../lib/occurrences";
import { localDayRange } from "../lib/time";
import { pushEnabled, pushToUser, type PushMessage } from "./push";
import { telegramEnabled } from "./telegram-bot";
import { TelegramClient } from "./telegram-client";

/** Maior antecedência aceita para lembrete (4 semanas), em ms. */
const MAX_LEAD = 40_320 * 60_000;
/** Lembrete atrasado mais do que isso (cron parado) não é mais enviado. */
const GRACE = 60 * 60_000;
/** Tarefa com prazo só de data avisa às 9h do dia (horário do workspace). */
const DATE_ONLY_HOUR = 9 * 3_600_000;

function leadText(minutes: number) {
  if (minutes === 0) return "agora";
  if (minutes % 1440 === 0) return minutes === 1440 ? "em 1 dia" : `em ${minutes / 1440} dias`;
  if (minutes % 60 === 0) return minutes === 60 ? "em 1 hora" : `em ${minutes / 60} horas`;
  return `em ${minutes} minutos`;
}

const hhmm = (ms: number, timeZone: string) => new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

/** "hoje", "amanhã" ou "12/10", no fuso do workspace. */
function dayLabel(ms: number, now: number, timeZone: string) {
  const [today, tomorrow] = localDayRange(now, timeZone);
  const [day] = localDayRange(ms, timeZone);
  if (day === today) return "hoje";
  if (day === tomorrow) return "amanhã";
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(ms);
}

/** Um aviso a entregar: `key` identifica o item e o momento; quem recebe e o texto de cada canal. */
interface Due {
  key: string;
  /** Chave antiga do Telegram para eventos (evento:início:vínculo), mantida para não repetir avisos já enviados. */
  telegramKey?: (linkId: string) => string;
  userIds: string[] | "all";
  telegram: string;
  push: PushMessage;
}

/**
 * O aviso venceu agora: passou da hora de avisar há menos de GRACE. Compromisso que já começou não é mais avisado;
 * prazo de tarefa vencido há pouco ainda é (o aviso "no prazo" pode atrasar um ciclo se o envio falhar).
 */
const isDue = (ref: number, leadMinutes: number, now: number, startedTolerance = 5 * 60_000) => {
  const at = ref - leadMinutes * 60_000;
  return at <= now && at > now - GRACE && ref >= now - startedTolerance;
};

async function dueEvents(db: Db, workspaceId: string, timeZone: string, now: number): Promise<Due[]> {
  const occ = await listOccurrences(db, workspaceId, now - GRACE, now + MAX_LEAD);
  return occ
    .filter((o) => o.reminderMinutes != null && isDue(o.startAt, o.reminderMinutes, now))
    .map((o) => {
      const lead = leadText(o.reminderMinutes!);
      const when = o.allDay ? `${dayLabel(o.startAt, now, timeZone)}, dia inteiro` : `${dayLabel(o.startAt, now, timeZone)} às ${hhmm(o.startAt, timeZone)}`;
      return {
        key: `event:${o.id}:${o.occurrenceStart}`,
        telegramKey: (linkId: string) => `${o.id}:${o.occurrenceStart}:${linkId}`,
        userIds: "all" as const,
        telegram: o.allDay ? `Lembrete: ${o.title} (dia inteiro, ${lead})` : `Lembrete: ${o.title} às ${hhmm(o.startAt, timeZone)} (${lead})`,
        push: { title: o.title, body: `${when[0].toUpperCase()}${when.slice(1)} (${lead})`, url: "/agenda", tag: `event:${o.id}:${o.occurrenceStart}` },
      };
    });
}

async function dueTasks(db: Db, workspaceId: string, timeZone: string, now: number): Promise<Due[]> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt, reminderMinutes: tasks.reminderMinutes, assigneeId: tasks.assigneeId, createdBy: tasks.createdBy })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        ne(tasks.status, "done"),
        isNotNull(tasks.reminderMinutes),
        between(tasks.dueAt, now - GRACE - DATE_ONLY_HOUR, now + MAX_LEAD + DATE_ONLY_HOUR),
      ),
    );
  const out: Due[] = [];
  for (const t of rows) {
    const [dayStart] = localDayRange(t.dueAt!, timeZone);
    const dateOnly = t.dueAt === dayStart;
    const ref = dateOnly ? dayStart + DATE_ONLY_HOUR : t.dueAt!;
    if (!isDue(ref, t.reminderMinutes!, now, GRACE)) continue;
    const who = t.assigneeId ?? t.createdBy;
    if (!who) continue;
    const when = dateOnly ? dayLabel(ref, now, timeZone) : `${dayLabel(ref, now, timeZone)} às ${hhmm(ref, timeZone)}`;
    out.push({
      // O prazo entra na chave: se o prazo mudar, o aviso vale de novo.
      key: `task:${t.id}:${ref}`,
      userIds: [who],
      telegram: `Tarefa: ${t.title} (prazo ${when})`,
      push: { title: `Tarefa: ${t.title}`, body: `Prazo ${when}`, url: "/tarefas", tag: `task:${t.id}` },
    });
  }
  return out;
}

async function claim(db: Db, key: string) {
  return (await db.insert(reminderLog).values({ key }).onConflictDoNothing().returning({ key: reminderLog.key })).length > 0;
}

/**
 * Envia os avisos que venceram (roda no cron de 5 minutos): compromissos da agenda e prazos de tarefas,
 * pelo Telegram e pelos aparelhos com alertas ativados. Cada aviso vai uma vez por item, pessoa e canal:
 * a chave em reminder_log impede repetição.
 */
export async function sendReminders(deps: { db: Db; env: Env; now?: () => number }) {
  const { db, env } = deps;
  const now = deps.now?.() ?? Date.now();

  const links = telegramEnabled(env)
    ? await db
        .select({ id: telegramLinks.id, workspaceId: telegramLinks.workspaceId, userId: telegramLinks.userId, chatId: telegramLinks.chatId })
        .from(telegramLinks)
        .innerJoin(memberships, and(eq(memberships.workspaceId, telegramLinks.workspaceId), eq(memberships.userId, telegramLinks.userId)))
        .where(eq(telegramLinks.reminders, true))
    : [];
  const pushUsers = pushEnabled(env)
    ? await db
        .selectDistinct({ workspaceId: pushSubscriptions.workspaceId, userId: pushSubscriptions.userId })
        .from(pushSubscriptions)
        .innerJoin(memberships, and(eq(memberships.workspaceId, pushSubscriptions.workspaceId), eq(memberships.userId, pushSubscriptions.userId)))
    : [];
  const workspaceIds = new Set([...links, ...pushUsers].map((r) => r.workspaceId));
  if (!workspaceIds.size) return 0;

  const tg = links.length ? new TelegramClient(env.TELEGRAM_BOT_TOKEN!) : null;
  let sent = 0;
  for (const workspaceId of workspaceIds) {
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!ws) continue;
    const due = [...(await dueEvents(db, workspaceId, ws.timezone, now)), ...(await dueTasks(db, workspaceId, ws.timezone, now))];
    const wsLinks = links.filter((l) => l.workspaceId === workspaceId);
    const wsPush = pushUsers.filter((p) => p.workspaceId === workspaceId).map((p) => p.userId);
    for (const d of due) {
      const wants = (userId: string) => d.userIds === "all" || d.userIds.includes(userId);

      for (const link of wsLinks.filter((l) => wants(l.userId))) {
        const key = d.telegramKey?.(link.id) ?? `${d.key}:tg:${link.id}`;
        if (!(await claim(db, key))) continue;
        try {
          await tg!.sendMessage(link.chatId, d.telegram);
          sent++;
        } catch (e) {
          // Libera a chave para tentar de novo no próximo ciclo.
          await db.delete(reminderLog).where(eq(reminderLog.key, key));
          await recordError(db, "lembrete telegram", e);
        }
      }

      for (const userId of wsPush.filter(wants)) {
        const key = `${d.key}:push:${userId}`;
        if (!(await claim(db, key))) continue;
        const r = await pushToUser(deps, workspaceId, userId, d.push);
        if (r.sent) sent++;
        // Nenhum aparelho aceitou: tenta de novo no próximo ciclo (aparelhos cancelados já saíram da lista).
        else await db.delete(reminderLog).where(eq(reminderLog.key, key));
      }
    }
  }
  return sent;
}

/** Limpeza: chaves de lembretes com mais de 60 dias. */
export async function pruneReminders(db: Db, now = Date.now()) {
  await db.delete(reminderLog).where(lt(reminderLog.sentAt, now - 60 * 86_400_000));
}
