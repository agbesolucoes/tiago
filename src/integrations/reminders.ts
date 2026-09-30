import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { memberships, reminderLog, telegramLinks, workspaces } from "../db/schema";
import type { Env } from "../env";
import { recordError } from "../lib/log";
import { listOccurrences } from "../lib/occurrences";
import { telegramEnabled } from "./telegram-bot";
import { TelegramClient } from "./telegram-client";

/** Maior antecedência aceita para lembrete (4 semanas), em ms. */
const MAX_LEAD = 40_320 * 60_000;
/** Lembrete atrasado mais do que isso (cron parado) não é mais enviado. */
const GRACE = 60 * 60_000;

function leadText(minutes: number) {
  if (minutes === 0) return "agora";
  if (minutes % 1440 === 0) return minutes === 1440 ? "em 1 dia" : `em ${minutes / 1440} dias`;
  if (minutes % 60 === 0) return minutes === 60 ? "em 1 hora" : `em ${minutes / 60} horas`;
  return `em ${minutes} minutos`;
}

/**
 * Envia pelo Telegram os lembretes que venceram (roda no cron de 5 minutos).
 * Cada lembrete vai uma vez por ocorrência e pessoa: a chave em reminder_log impede repetição.
 */
export async function sendReminders(deps: { db: Db; env: Env; now?: () => number }) {
  if (!telegramEnabled(deps.env)) return 0;
  const { db } = deps;
  const now = deps.now?.() ?? Date.now();
  const links = await db
    .select({ id: telegramLinks.id, workspaceId: telegramLinks.workspaceId, userId: telegramLinks.userId, chatId: telegramLinks.chatId, timezone: workspaces.timezone })
    .from(telegramLinks)
    .innerJoin(workspaces, eq(workspaces.id, telegramLinks.workspaceId))
    .innerJoin(memberships, and(eq(memberships.workspaceId, telegramLinks.workspaceId), eq(memberships.userId, telegramLinks.userId)))
    .where(eq(telegramLinks.reminders, true));
  if (!links.length) return 0;
  const tg = new TelegramClient(deps.env.TELEGRAM_BOT_TOKEN!);
  let sent = 0;
  for (const workspaceId of new Set(links.map((l) => l.workspaceId))) {
    const due = (await listOccurrences(db, workspaceId, now - GRACE, now + MAX_LEAD)).filter(
      (o) => o.reminderMinutes != null && o.startAt - o.reminderMinutes * 60_000 <= now && o.startAt - o.reminderMinutes * 60_000 > now - GRACE && o.startAt >= now - 5 * 60_000,
    );
    for (const o of due) {
      for (const link of links.filter((l) => l.workspaceId === workspaceId)) {
        const key = `${o.id}:${o.occurrenceStart}:${link.id}`;
        const claimed = await db.insert(reminderLog).values({ key }).onConflictDoNothing().returning({ key: reminderLog.key });
        if (!claimed.length) continue;
        const time = new Intl.DateTimeFormat("pt-BR", { timeZone: link.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(o.startAt);
        const text = o.allDay ? `Lembrete: ${o.title} (dia inteiro, ${leadText(o.reminderMinutes!)})` : `Lembrete: ${o.title} às ${time} (${leadText(o.reminderMinutes!)})`;
        try {
          await tg.sendMessage(link.chatId, text);
          sent++;
        } catch (e) {
          // Libera a chave para tentar de novo no próximo ciclo.
          await db.delete(reminderLog).where(eq(reminderLog.key, key));
          await recordError(db, "lembrete telegram", e);
        }
      }
    }
  }
  return sent;
}

/** Limpeza: chaves de lembretes com mais de 60 dias. */
export async function pruneReminders(db: Db, now = Date.now()) {
  await db.delete(reminderLog).where(lt(reminderLog.sentAt, now - 60 * 86_400_000));
}
