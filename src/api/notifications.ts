import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { pushSubscriptions } from "../db/schema";
import { getVapidKeys, pushEnabled, pushToUser } from "../integrations/push";
import { newId } from "../lib/crypto";
import { fromBase64url, isPushEndpoint } from "../lib/webpush";
import type { AppEnv } from "./context";
import { notFound, parseBody, serialize, ValidationError } from "./helpers";

// Alertas pelo navegador: cada pessoa ativa nos próprios aparelhos (Configurações → Alertas).

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/, "formato inválido");
const deviceBody = z.strictObject({
  endpoint: z.string().max(1000),
  keys: z.strictObject({ p256dh: b64url.max(200), auth: b64url.max(100) }),
  label: z.string().trim().max(80).nullable().optional(),
});

const DATE_COLUMNS = { createdAt: pushSubscriptions.createdAt, lastSuccessAt: pushSubscriptions.lastSuccessAt };

export function registerNotifications(api: Hono<AppEnv>) {
  api.get("/notifications", async (c) => {
    const ctx = c.get("ctx");
    if (!pushEnabled(c.env)) return c.json({ push: { enabled: false, publicKey: null }, devices: [] });
    const { publicKey } = await getVapidKeys(ctx.db, c.env);
    const devices = await ctx.db
      .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, label: pushSubscriptions.label, ...DATE_COLUMNS })
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.workspaceId, ctx.workspaceId), eq(pushSubscriptions.userId, ctx.userId)))
      .orderBy(desc(pushSubscriptions.createdAt));
    return c.json({
      push: { enabled: true, publicKey },
      devices: devices.map((d) => ({ ...serialize(d), lastSuccessAt: d.lastSuccessAt ? new Date(d.lastSuccessAt).toISOString() : null })),
    });
  });

  /** Registra (ou passa para a pessoa logada) o aparelho deste navegador. */
  api.post("/notifications/devices", async (c) => {
    const ctx = c.get("ctx");
    if (!pushEnabled(c.env)) throw new HTTPException(503, { message: "alertas indisponíveis neste servidor" });
    const body = await parseBody(c, deviceBody);
    if (!isPushEndpoint(body.endpoint)) throw new ValidationError([{ path: "endpoint", message: "serviço de push não reconhecido" }]);
    if (fromBase64url(body.keys.p256dh).length !== 65 || fromBase64url(body.keys.auth).length !== 16)
      throw new ValidationError([{ path: "keys", message: "chaves do navegador inválidas" }]);
    const values = { workspaceId: ctx.workspaceId, userId: ctx.userId, p256dh: body.keys.p256dh, auth: body.keys.auth, label: body.label ?? null, updatedAt: Date.now() };
    await ctx.db
      .insert(pushSubscriptions)
      .values({ id: newId(), endpoint: body.endpoint, ...values })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
    const row = await ctx.db.query.pushSubscriptions.findFirst({ where: eq(pushSubscriptions.endpoint, body.endpoint) });
    return c.json({ id: row!.id }, 201);
  });

  api.delete("/notifications/devices/:id", async (c) => {
    const ctx = c.get("ctx");
    const where = and(eq(pushSubscriptions.id, c.req.param("id")), eq(pushSubscriptions.workspaceId, ctx.workspaceId), eq(pushSubscriptions.userId, ctx.userId));
    const row = await ctx.db.query.pushSubscriptions.findFirst({ where });
    if (!row) notFound();
    await ctx.db.delete(pushSubscriptions).where(where);
    return c.body(null, 204);
  });

  /** Alerta de teste para os aparelhos da pessoa logada. */
  api.post("/notifications/test", async (c) => {
    const ctx = c.get("ctx");
    if (!pushEnabled(c.env)) throw new HTTPException(503, { message: "alertas indisponíveis neste servidor" });
    const r = await pushToUser({ db: ctx.db, env: c.env }, ctx.workspaceId, ctx.userId, {
      title: "Central de Organização",
      body: "Alertas ligados. Você vai receber os lembretes de tarefas e compromissos aqui.",
      url: "/configuracoes",
      tag: "teste",
    });
    return c.json(r);
  });
}
