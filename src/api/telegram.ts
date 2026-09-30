import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { telegramLinks } from "../db/schema";
import { createLinkCode, telegramEnabled } from "../integrations/telegram-bot";
import { TelegramClient, TelegramError } from "../integrations/telegram-client";
import { requireRole, type AppEnv } from "./context";
import { auditInsert, parseBody } from "./helpers";

const telegramPatch = z.strictObject({ dailySummary: z.boolean() });

/** Rotas do Telegram em /api/integrations/telegram. Cada pessoa liga a própria conta. */
export function registerTelegram(api: Hono<AppEnv>) {
  api.get("/telegram", async (c) => {
    const ctx = c.get("ctx");
    const link = await ctx.db.query.telegramLinks.findFirst({
      where: and(eq(telegramLinks.workspaceId, ctx.workspaceId), eq(telegramLinks.userId, ctx.userId)),
    });
    return c.json({
      enabled: telegramEnabled(c.env),
      botUsername: c.env.TELEGRAM_BOT_USERNAME ?? null,
      linked: !!link,
      username: link?.username ?? null,
      dailySummary: link?.dailySummary ?? true,
    });
  });

  api.post("/telegram/code", async (c) => {
    const ctx = c.get("ctx");
    if (!telegramEnabled(c.env)) return c.json({ error: "o bot do Telegram ainda não foi configurado no servidor" }, 409);
    const { code, expiresAt } = await createLinkCode(ctx.db, ctx.workspaceId, ctx.userId);
    const bot = c.env.TELEGRAM_BOT_USERNAME;
    c.header("cache-control", "no-store");
    return c.json({ code, expiresAt: new Date(expiresAt).toISOString(), deepLink: bot ? `https://t.me/${bot}?start=${code}` : null }, 201);
  });

  api.patch("/telegram", async (c) => {
    const ctx = c.get("ctx");
    const body = await parseBody(c, telegramPatch);
    const res = await ctx.db
      .update(telegramLinks)
      .set({ dailySummary: body.dailySummary, updatedAt: Date.now() })
      .where(and(eq(telegramLinks.workspaceId, ctx.workspaceId), eq(telegramLinks.userId, ctx.userId)))
      .returning({ id: telegramLinks.id });
    if (!res.length) return c.json({ error: "Telegram não vinculado" }, 404);
    return c.json({ dailySummary: body.dailySummary });
  });

  api.delete("/telegram", async (c) => {
    const ctx = c.get("ctx");
    const link = await ctx.db.query.telegramLinks.findFirst({
      where: and(eq(telegramLinks.workspaceId, ctx.workspaceId), eq(telegramLinks.userId, ctx.userId)),
    });
    if (link) {
      await ctx.db.batch([
        ctx.db.delete(telegramLinks).where(eq(telegramLinks.id, link.id)),
        auditInsert(ctx, "telegram", link.id, "delete", { telegramUserId: link.telegramUserId, username: link.username }, null),
      ]);
    }
    return c.body(null, 204);
  });

  /** Registra no Telegram o endereço do webhook com o segredo. Só dono ou administrador. */
  api.post("/telegram/webhook", async (c) => {
    const ctx = c.get("ctx");
    requireRole(ctx, "owner", "admin");
    if (!telegramEnabled(c.env)) return c.json({ error: "o bot do Telegram ainda não foi configurado no servidor" }, 409);
    const url = new URL("/integrations/telegram/webhook", c.env.APP_URL).toString();
    try {
      await new TelegramClient(c.env.TELEGRAM_BOT_TOKEN!).setWebhook(url, c.env.TELEGRAM_WEBHOOK_SECRET!);
    } catch (e) {
      const msg = e instanceof TelegramError ? e.description : "falha ao falar com o Telegram";
      return c.json({ error: `O Telegram recusou: ${msg}` }, 502);
    }
    return c.json({ ok: true, url });
  });
}
