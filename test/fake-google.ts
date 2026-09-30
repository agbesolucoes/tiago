import type { GoogleEvent } from "../src/integrations/google-client";

/** Google Calendar em memória, o suficiente para testar a sincronização. */
export class FakeGoogle {
  calendars = [
    { id: "primary@x.com", summary: "Pessoal", primary: true, accessRole: "owner" },
    { id: "trabalho@x.com", summary: "Trabalho", accessRole: "writer" },
    { id: "feriados@x.com", summary: "Feriados", accessRole: "reader" },
  ];
  events = new Map<string, Map<string, GoogleEvent & { seq: number }>>();
  seq = 0;
  calls: { method: string; path: string; body?: any }[] = [];
  /** Falhas programadas: a próxima chamada que casar com a chave recebe esse status. */
  failNext = new Map<string, number>();
  tokenRevoked = false;
  pageSize = 2;
  expiredSyncTokens = new Set<string>();
  /** Resposta do endpoint de token para a troca do código (conexão OAuth). */
  onCode?: (body: Record<string, string>) => unknown;

  store(cal: string) {
    if (!this.events.has(cal)) this.events.set(cal, new Map());
    return this.events.get(cal)!;
  }

  put(cal: string, ev: GoogleEvent) {
    this.store(cal).set(ev.id, { status: "confirmed", ...ev, seq: ++this.seq, updated: new Date().toISOString() });
  }

  private json(status: number, body: unknown) {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private failure(key: string) {
    const status = this.failNext.get(key);
    if (status) {
      this.failNext.delete(key);
      return this.json(status, { error: { code: status, message: `falha simulada ${status}`, errors: [{ reason: status === 429 ? "rateLimitExceeded" : "backendError" }] } });
    }
    return null;
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : typeof init?.body === "string" ? (init.body.startsWith("{") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined;
    this.calls.push({ method, path: url.pathname + url.search, body });

    if (url.hostname === "oauth2.googleapis.com") {
      if (url.pathname === "/revoke") return this.json(200, {});
      if (body?.grant_type === "authorization_code" && this.onCode) return this.json(200, this.onCode(body));
      if (this.tokenRevoked) return this.json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      return this.json(200, { access_token: `at-${this.seq}`, expires_in: 3600 });
    }

    const m = url.pathname.match(/^\/calendar\/v3\/(users\/me\/calendarList|calendars\/([^/]+)\/events(?:\/([^/]+))?)$/);
    if (!m) return this.json(404, {});
    if (m[1] === "users/me/calendarList") return this.json(200, { items: this.calendars });
    const cal = decodeURIComponent(m[2]);
    const id = m[3] && decodeURIComponent(m[3]);
    const f = this.failure(`${method} ${cal}`);
    if (f) return f;
    const store = this.store(cal);

    if (method === "GET") {
      const syncToken = url.searchParams.get("syncToken");
      if (syncToken && this.expiredSyncTokens.has(syncToken)) return this.json(410, { error: { code: 410, message: "Sync token is no longer valid" } });
      const since = syncToken ? Number(syncToken.split(":")[1]) : 0;
      const all = [...store.values()].filter((e) => e.seq > since && (syncToken || e.status !== "cancelled")).sort((a, b) => a.seq - b.seq);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const items = all.slice(offset, offset + this.pageSize).map(({ seq: _s, ...e }) => e);
      const more = offset + this.pageSize < all.length;
      return this.json(200, { items, ...(more ? { nextPageToken: String(offset + this.pageSize) } : { nextSyncToken: `tok:${this.seq}` }) });
    }
    if (method === "POST") {
      if (store.has(body.id)) return this.json(409, { error: { code: 409, message: "The requested identifier already exists.", errors: [{ reason: "duplicate" }] } });
      this.put(cal, body);
      const { seq: _s, ...saved } = store.get(body.id)!;
      return this.json(200, saved);
    }
    if (method === "PATCH") {
      const current = store.get(id!);
      if (!current || current.status === "cancelled") return this.json(404, { error: { code: 404, message: "Not Found" } });
      this.put(cal, { ...current, ...body, id: id! });
      const { seq: _s, ...saved } = store.get(id!)!;
      return this.json(200, saved);
    }
    if (method === "DELETE") {
      const current = store.get(id!);
      if (!current || current.status === "cancelled") return this.json(410, { error: { code: 410, message: "Resource has been deleted" } });
      this.put(cal, { ...current, status: "cancelled" });
      return this.json(204, null);
    }
    return this.json(405, {});
  }) as typeof fetch;
}
