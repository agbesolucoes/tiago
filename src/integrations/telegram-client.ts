// Cliente mínimo da Bot API do Telegram. `telegramFetch.impl` é trocado nos testes.

export const telegramFetch: { impl: typeof fetch } = { impl: (input, init) => fetch(input, init) };

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

export class TelegramError extends Error {
  constructor(
    public method: string,
    public description: string,
  ) {
    super(`Telegram ${method}: ${description}`);
  }
}

export class TelegramClient {
  constructor(private token: string) {}

  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await telegramFetch.impl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !data.ok) throw new TelegramError(method, data.description ?? `HTTP ${res.status}`);
    return data.result as T;
  }

  sendMessage(chatId: number | string, text: string, buttons?: InlineButton[][]) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(buttons && { reply_markup: { inline_keyboard: buttons } }),
    });
  }

  editMessageText(chatId: number | string, messageId: number, text: string) {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } });
  }

  answerCallbackQuery(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text && { text }) });
  }

  setWebhook(url: string, secret: string) {
    return this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
  }

  getFile(fileId: string) {
    return this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  }

  /** Baixa um arquivo enviado ao bot (a Bot API entrega até 20 MB). */
  async download(filePath: string) {
    const res = await telegramFetch.impl(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new TelegramError("download", `HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  getMe() {
    return this.call<{ username: string }>("getMe", {});
  }
}
