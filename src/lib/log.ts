import type { Db } from "../db/client";
import { appErrors } from "../db/schema";
import { newId } from "./crypto";

// Logs em JSON de uma linha: o Workers Logs indexa os campos.

export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/** Registra o erro no log e na tabela app_errors (tela "Saúde do sistema"). Nunca lança. */
export async function recordError(db: Db, source: string, err: unknown, requestId?: string) {
  const message = errorMessage(err).slice(0, 1000);
  log("error", source, { message, requestId, stack: err instanceof Error ? err.stack?.split("\n").slice(0, 5).join(" | ") : undefined });
  try {
    await db.insert(appErrors).values({ id: newId(), source, message, requestId: requestId ?? null });
  } catch (e) {
    log("error", "app_errors.insert", { message: errorMessage(e) });
  }
}
