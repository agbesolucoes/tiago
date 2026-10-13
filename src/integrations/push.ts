import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { appSecrets, pushSubscriptions } from "../db/schema";
import type { Env } from "../env";
import { recordError } from "../lib/log";
import { decryptSecret, encryptSecret } from "../lib/secret";
import { generateVapidKeys, sendPush, type VapidKeys } from "../lib/webpush";

// Alertas pelo navegador (Web Push). As chaves VAPID nascem sozinhas no primeiro uso e ficam
// cifradas no banco, então não há variável nova para configurar no servidor.

const VAPID_KEY = "vapid";

export interface PushMessage {
  title: string;
  body: string;
  /** Tela que abre ao tocar no alerta. */
  url: string;
  /** Alertas com a mesma tag se substituem no aparelho. */
  tag?: string;
}

export function pushEnabled(env: Env) {
  return !!env.TOKEN_ENCRYPTION_KEY;
}

export async function getVapidKeys(db: Db, env: Env): Promise<VapidKeys> {
  const read = () => db.query.appSecrets.findFirst({ where: eq(appSecrets.key, VAPID_KEY) });
  let row = await read();
  if (!row) {
    const keys = await generateVapidKeys();
    // Duas requisições ao mesmo tempo: a primeira grava, a outra lê a que ficou.
    await db
      .insert(appSecrets)
      .values({ key: VAPID_KEY, value: await encryptSecret(JSON.stringify(keys), env.TOKEN_ENCRYPTION_KEY) })
      .onConflictDoNothing();
    row = (await read())!;
  }
  return JSON.parse(await decryptSecret(row.value, env.TOKEN_ENCRYPTION_KEY)) as VapidKeys;
}

/** O serviço de push da Apple exige `sub` com https: ou mailto:. */
const subject = (env: Env) => (env.APP_URL.startsWith("https://") ? env.APP_URL : "mailto:alertas@central.invalid");

/** Manda o alerta para todos os aparelhos da pessoa. Devolve quantos aceitaram. */
export async function pushToUser(deps: { db: Db; env: Env; now?: () => number }, workspaceId: string, userId: string, message: PushMessage) {
  const { db, env } = deps;
  const subs = await db.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.workspaceId, workspaceId), eq(pushSubscriptions.userId, userId)));
  if (!subs.length) return { sent: 0, devices: 0 };
  const keys = await getVapidKeys(db, env);
  let sent = 0;
  for (const s of subs) {
    try {
      const { result, status } = await sendPush(s, message, keys, subject(env));
      if (result === "ok") {
        sent++;
        await db.update(pushSubscriptions).set({ lastSuccessAt: deps.now?.() ?? Date.now() }).where(eq(pushSubscriptions.id, s.id));
      } else if (result === "gone") {
        // O navegador cancelou a permissão ou o aparelho foi trocado: a inscrição não volta mais.
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
      } else {
        await recordError(db, "alerta push", new Error(`serviço de push respondeu ${status}`));
      }
    } catch (e) {
      await recordError(db, "alerta push", e);
    }
  }
  return { sent, devices: subs.length };
}
