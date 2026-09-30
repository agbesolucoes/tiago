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
    const q = new URLSearchParams({ maxResults: "250", singleEvents: "true", showDeleted: "true" });
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
