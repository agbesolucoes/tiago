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

  // ---------- Drive ----------
  files = new Map<string, { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; size?: string; content?: string; byApp: boolean }>();
  uploads = new Map<string, { name: string; parents: string[]; mimeType: string; size: number }>();
  fileSeq = 0;

  addUserFile(name: string, byApp = false) {
    const id = `f${++this.fileSeq}`;
    this.files.set(id, { id, name, mimeType: "application/pdf", parents: ["root"], trashed: false, size: "10", byApp });
    return id;
  }

  private fileView(f: { id: string; name: string; mimeType: string; parents: string[]; trashed: boolean; size?: string }) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, trashed: f.trashed, size: f.size, webViewLink: `https://drive.google.com/file/d/${f.id}/view` };
  }

  /** Arquivos que o app enxerga com drive.file: os que ele criou ou os escolhidos pela pessoa. */
  pickedIds = new Set<string>();

  private async drive(url: URL, method: string, init?: RequestInit) {
    const f = this.failure(`${method} drive`);
    if (f) return f;
    if (url.pathname.includes("/permissions")) return this.json(403, { error: { code: 403, message: "ACL não deve ser tocada" } });
    const visible = (id: string) => {
      const file = this.files.get(id);
      return file && (file.byApp || this.pickedIds.has(id)) ? file : null;
    };
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const name = q.match(/name='((?:[^'\\]|\\.)*)'/)?.[1];
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const items = [...this.files.values()].filter((x) => x.byApp && !x.trashed && x.name === name && x.parents.includes(parent!) && x.mimeType === "application/vnd.google-apps.folder");
      return this.json(200, { files: items.map((x) => this.fileView(x)) });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const body = JSON.parse(init!.body as string);
      const id = `d${++this.fileSeq}`;
      this.files.set(id, { id, name: body.name, mimeType: body.mimeType, parents: body.parents ?? ["root"], trashed: false, byApp: true });
      return this.json(200, this.fileView(this.files.get(id)!));
    }
    const get = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (get && method === "GET") {
      const file = visible(decodeURIComponent(get[1]));
      return file ? this.json(200, this.fileView(file)) : this.json(404, { error: { code: 404, message: "File not found" } });
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(init!.body as string);
      const h = new Headers(init!.headers);
      const session = `s${++this.fileSeq}`;
      this.uploads.set(session, { name: meta.name, parents: meta.parents, mimeType: h.get("x-upload-content-type")!, size: Number(h.get("x-upload-content-length")) });
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${session}` } });
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "PUT") {
      const session = this.uploads.get(url.searchParams.get("upload_id")!);
      if (!session) return this.json(404, {});
      const content = await new Response(init!.body as BodyInit).text();
      const id = `u${++this.fileSeq}`;
      this.files.set(id, { id, name: session.name, mimeType: session.mimeType, parents: session.parents, trashed: false, size: String(content.length), content, byApp: true });
      return this.json(200, this.fileView(this.files.get(id)!));
    }
    return this.json(404, {});
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

    if (url.pathname.startsWith("/drive/") || url.pathname.startsWith("/upload/drive/")) return this.drive(url, method, init);

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
      // Como o Google: exceções canceladas de uma série vêm mesmo no sync completo.
      const all = [...store.values()].filter((e) => e.seq > since && (syncToken || e.status !== "cancelled" || !!e.recurringEventId)).sort((a, b) => a.seq - b.seq);
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
