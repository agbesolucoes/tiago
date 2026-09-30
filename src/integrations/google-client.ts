// Cliente mínimo das APIs do Google usadas pela Central. `fetcher` é injetável para testes.

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CAL = "https://www.googleapis.com/calendar/v3";

/** fetch usado nas chamadas ao Google. Os testes trocam por um Google falso. */
export const googleFetch: { impl: typeof fetch } = { impl: (...args) => fetch(...args) };

export class GoogleError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
  /** Token revogado ou expirado sem volta: só reconectando. */
  get revoked() {
    return this.reason === "invalid_grant" || this.status === 401;
  }
  /** Vale tentar de novo mais tarde. */
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500 || this.reason === "rateLimitExceeded" || this.reason === "userRateLimitExceeded";
  }
}

export interface GoogleEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  updated?: string;
  etag?: string;
  /** Série: linhas RRULE/EXDATE. Exceção: id da série e início original da ocorrência. */
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string; timeZone?: string };
  reminders?: { useDefault?: boolean; overrides?: { method: string; minutes: number }[] };
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: "freeBusyReader" | "reader" | "writer" | "owner";
}

async function parseError(res: Response): Promise<GoogleError> {
  const body = (await res.json().catch(() => ({}))) as any;
  const reason = body?.error?.errors?.[0]?.reason ?? (typeof body?.error === "string" ? body.error : "") ?? "";
  const message = body?.error?.message ?? body?.error_description ?? `Google respondeu ${res.status}`;
  return new GoogleError(res.status, reason, message);
}

export class GoogleClient {
  constructor(
    private accessToken: string,
    private fetcher: typeof fetch = googleFetch.impl,
  ) {}

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(url, {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new GoogleError(0, "network", (e as Error).message);
    }
    if (!res.ok) throw await parseError(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async listCalendars(): Promise<CalendarListEntry[]> {
    const out: CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ maxResults: "250", ...(pageToken && { pageToken }) });
      const page = await this.call<{ items?: CalendarListEntry[]; nextPageToken?: string }>("GET", `${CAL}/users/me/calendarList?${q}`);
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** Uma página de eventos. Sem syncToken usa timeMin (sync inicial). */
  listEvents(calendarId: string, opts: { syncToken?: string | null; timeMin?: string; pageToken?: string }) {
    // singleEvents=false: séries chegam como um mestre com RRULE, e as exceções vêm separadas.
    const q = new URLSearchParams({ maxResults: "250", singleEvents: "false", showDeleted: "true" });
    if (opts.pageToken) q.set("pageToken", opts.pageToken);
    if (opts.syncToken) q.set("syncToken", opts.syncToken);
    else if (opts.timeMin) q.set("timeMin", opts.timeMin);
    return this.call<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
      "GET",
      `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
    );
  }

  insertEvent(calendarId: string, event: GoogleEvent) {
    // sendUpdates=none: convites só por ação explícita (ainda não há participantes).
    return this.call<GoogleEvent>("POST", `${CAL}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, event);
  }

  patchEvent(calendarId: string, eventId: string, event: Partial<GoogleEvent>) {
    return this.call<GoogleEvent>(
      "PATCH",
      `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      event,
    );
  }

  deleteEvent(calendarId: string, eventId: string) {
    return this.call<void>("DELETE", `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`);
  }
}

export async function refreshAccessToken(opts: { refreshToken: string; clientId: string; clientSecret: string; fetcher?: typeof fetch }) {
  let res: Response;
  try {
    res = await (opts.fetcher ?? googleFetch.impl)(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: opts.refreshToken,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      }),
    });
  } catch (e) {
    throw new GoogleError(0, "network", (e as Error).message);
  }
  if (!res.ok) throw await parseError(res);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
}

export async function revokeToken(token: string, fetcher: typeof fetch = googleFetch.impl) {
  await fetcher(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => {});
}

// ---------- Drive (escopo drive.file: só arquivos criados pela Central ou escolhidos no Picker) ----------

const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,size,webViewLink,trashed,parents";

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  trashed?: boolean;
  parents?: string[];
}

export class DriveClient {
  constructor(
    private accessToken: string,
    private fetcher: typeof fetch = googleFetch.impl,
  ) {}

  private async call<T>(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<{ data: T; res: Response }> {
    let res: Response;
    try {
      res = await this.fetcher(url, { method, headers: { authorization: `Bearer ${this.accessToken}`, ...init.headers }, body: init.body });
    } catch (e) {
      throw new GoogleError(0, "network", (e as Error).message);
    }
    if (!res.ok) throw await parseError(res);
    // A abertura da sessão de upload responde 200 sem corpo.
    const text = res.status === 204 ? "" : await res.text();
    return { data: (text ? JSON.parse(text) : undefined) as T, res };
  }

  async getFile(id: string): Promise<DriveFile> {
    return (await this.call<DriveFile>("GET", `${DRIVE}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`)).data;
  }

  async findFolder(name: string, parentId?: string): Promise<DriveFile | null> {
    const q = [`mimeType='${FOLDER_MIME}'`, `name='${name.replace(/'/g, "\\'")}'`, "trashed=false", parentId ? `'${parentId}' in parents` : "'root' in parents"].join(" and ");
    const params = new URLSearchParams({ q, fields: `files(${FILE_FIELDS})`, pageSize: "10", spaces: "drive" });
    const { data } = await this.call<{ files?: DriveFile[] }>("GET", `${DRIVE}/files?${params}`);
    return data.files?.[0] ?? null;
  }

  async createFolder(name: string, parentId?: string): Promise<DriveFile> {
    const body = JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId && { parents: [parentId] }) });
    return (await this.call<DriveFile>("POST", `${DRIVE}/files?fields=${FILE_FIELDS}`, { body, headers: { "content-type": "application/json" } })).data;
  }

  /** Abre uma sessão de upload retomável e devolve a URL da sessão. */
  async startUpload(meta: { name: string; parentId: string; mimeType: string; size: number }): Promise<string> {
    const { res } = await this.call<unknown>("POST", `${DRIVE_UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}`, {
      body: JSON.stringify({ name: meta.name, parents: [meta.parentId], mimeType: meta.mimeType }),
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": meta.mimeType,
        "x-upload-content-length": String(meta.size),
      },
    });
    const location = res.headers.get("location");
    if (!location) throw new GoogleError(502, "noUploadSession", "O Google não abriu a sessão de upload");
    return location;
  }

  /** Envia o conteúdo em streaming para a sessão (sem guardar o arquivo no servidor). */
  async upload(sessionUrl: string, body: ReadableStream | ArrayBuffer | Blob, size: number, mimeType: string): Promise<DriveFile> {
    return (await this.call<DriveFile>("PUT", sessionUrl, { body: body as BodyInit, headers: { "content-type": mimeType, "content-length": String(size) } })).data;
  }
}
