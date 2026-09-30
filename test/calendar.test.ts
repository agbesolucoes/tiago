import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calendars, events, integrationAccounts, syncJobs } from "../src/db/schema";
import {
  googleIdFor,
  processJobs,
  refreshCalendarList,
  syncCalendar,
  syncWorkspace,
  type SyncDeps,
} from "../src/integrations/calendar-sync";
import { googleFetch } from "../src/integrations/google-client";
import { newId } from "../src/lib/crypto";
import { decryptSecret, encryptSecret } from "../src/lib/secret";
import { FakeGoogle } from "./fake-google";
import { call, db, json, makeUser, type TestUser } from "./helpers";

const KEY = env.TOKEN_ENCRYPTION_KEY;
let g: FakeGoogle;
const realFetch = googleFetch.impl;

beforeEach(() => {
  g = new FakeGoogle();
  googleFetch.impl = g.fetch;
});
afterEach(() => {
  googleFetch.impl = realFetch;
});

const deps = (now?: () => number): SyncDeps => ({ db: db(), env, fetcher: g.fetch, now });

async function connect(user: TestUser) {
  const id = newId();
  await db()
    .insert(integrationAccounts)
    .values({
      id,
      workspaceId: user.workspaceId,
      userId: user.id,
      provider: "google",
      externalSub: "g-1",
      email: "dono@gmail.com",
      scopes: "calendar",
      refreshTokenEnc: await encryptSecret("refresh-secreto", KEY),
    });
  const account = (await db().query.integrationAccounts.findFirst({ where: eq(integrationAccounts.id, id) }))!;
  await refreshCalendarList(deps(), account);
  return (await db().query.integrationAccounts.findFirst({ where: eq(integrationAccounts.id, id) }))!;
}

const localEvents = (ws: string) => db().select().from(events).where(eq(events.workspaceId, ws)).orderBy(events.startAt);
const primaryCal = async (accountId: string) =>
  (await db().query.calendars.findFirst({ where: eq(calendars.accountId, accountId) , orderBy: (c, { desc }) => desc(c.primary) }))!;

describe("cifragem dos tokens", () => {
  it("cifra, decifra e recusa texto adulterado", async () => {
    const sealed = await encryptSecret("refresh-secreto", KEY);
    expect(sealed).not.toContain("refresh-secreto");
    expect(await decryptSecret(sealed, KEY)).toBe("refresh-secreto");
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow();
    expect(await encryptSecret("x", KEY)).not.toBe(await encryptSecret("x", KEY));
  });
});

describe("agendas", () => {
  it("lista as agendas, seleciona só a principal e a usa como destino", async () => {
    const u = await makeUser();
    const account = await connect(u);
    expect(account.defaultCalendarId).toBe("primary@x.com");
    const rows = await db().select().from(calendars).where(eq(calendars.accountId, account.id));
    const by = Object.fromEntries(rows.map((r) => [r.googleCalendarId, r]));
    expect(by["primary@x.com"]).toMatchObject({ selected: true, writable: true, primary: true });
    expect(by["trabalho@x.com"]).toMatchObject({ selected: false, writable: true });
    expect(by["feriados@x.com"]).toMatchObject({ selected: false, writable: false });
  });
});

describe("Google → Central", () => {
  it("sync inicial paginado, depois incremental com alteração, cancelamento e novo evento", async () => {
    const u = await makeUser();
    const account = await connect(u);
    g.put("primary@x.com", { id: "a1", summary: "Dentista", start: { dateTime: "2026-10-05T14:00:00-03:00" }, end: { dateTime: "2026-10-05T15:00:00-03:00" } });
    g.put("primary@x.com", { id: "a2", summary: "Feriado", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } });
    g.put("primary@x.com", { id: "a3", summary: "Reunião", start: { dateTime: "2026-10-06T09:00:00-03:00" }, end: { dateTime: "2026-10-06T10:00:00-03:00" } });

    const cal = await primaryCal(account.id);
    expect(await syncCalendar(deps(), account, cal)).toBe(3);
    let rows = await localEvents(u.workspaceId);
    expect(rows.map((r) => r.title)).toEqual(["Dentista", "Reunião", "Feriado"]);
    expect(new Date(rows[0].startAt).toISOString()).toBe("2026-10-05T17:00:00.000Z");
    const feriado = rows.find((r) => r.title === "Feriado")!;
    expect(feriado.allDay).toBe(true);
    expect(new Date(feriado.startAt).toISOString()).toBe("2026-10-12T03:00:00.000Z");
    expect(rows.every((r) => r.syncStatus === "synced" && r.calendarId === "primary@x.com")).toBe(true);
    expect(g.calls.filter((c) => c.path.includes("/events?")).length).toBe(2); // duas páginas

    g.put("primary@x.com", { ...g.store("primary@x.com").get("a1")!, summary: "Dentista (remarcado)", start: { dateTime: "2026-10-05T16:00:00-03:00" }, end: { dateTime: "2026-10-05T17:00:00-03:00" } });
    g.put("primary@x.com", { ...g.store("primary@x.com").get("a3")!, status: "cancelled" });
    g.put("primary@x.com", { id: "a4", summary: "Academia", start: { dateTime: "2026-10-07T07:00:00-03:00" }, end: { dateTime: "2026-10-07T08:00:00-03:00" } });

    const cal2 = await primaryCal(account.id);
    expect(cal2.syncToken).toBeTruthy();
    await syncCalendar(deps(), account, cal2);
    expect(g.calls.at(-1)!.path).toContain("syncToken=");
    rows = await localEvents(u.workspaceId);
    expect(rows.map((r) => r.title)).toEqual(["Dentista (remarcado)", "Academia", "Feriado"]);

    // Sem mudanças no Google, nada muda aqui.
    expect(await syncCalendar(deps(), account, await primaryCal(account.id))).toBe(0);
  });

  it("token de sync expirado (410) refaz o sync completo sem duplicar", async () => {
    const u = await makeUser();
    const account = await connect(u);
    g.put("primary@x.com", { id: "b1", summary: "Evento", start: { dateTime: "2026-10-05T14:00:00Z" }, end: { dateTime: "2026-10-05T15:00:00Z" } });
    await syncCalendar(deps(), account, await primaryCal(account.id));
    const cal = await primaryCal(account.id);
    g.expiredSyncTokens.add(cal.syncToken!);
    const before = g.calls.length;
    await syncCalendar(deps(), account, cal);
    expect(await localEvents(u.workspaceId)).toHaveLength(1);
    const lists = g.calls.slice(before).map((c) => c.path);
    expect(lists[0]).toContain("syncToken=");
    expect(lists[1]).toContain("timeMin=");
  });
});

describe("Central → Google", () => {
  it("compromisso criado vai para o Google com id idempotente e volta sem duplicar", async () => {
    const u = await makeUser();
    await connect(u);
    const created = await json(await call(u, "POST", "/api/events", { title: "Consulta", startAt: "2026-10-08T10:00", endAt: "2026-10-08T11:00" }));
    expect(created.syncStatus).toBe("pending");

    expect(await processJobs(deps(), { workspaceId: u.workspaceId })).toEqual({ done: 1, retried: 0, failed: 0 });
    const remote = g.store("primary@x.com").get(googleIdFor(created.id))!;
    expect(remote.summary).toBe("Consulta");
    expect(remote.start).toEqual({ dateTime: "2026-10-08T13:00:00.000Z", timeZone: "America/Sao_Paulo" });
    expect(g.calls.find((c) => c.method === "POST" && c.path.startsWith("/calendar"))!.path).toContain("sendUpdates=none");

    const local = await json(await call(u, "GET", `/api/events/${created.id}`));
    expect(local).toMatchObject({ syncStatus: "synced", remoteId: googleIdFor(created.id), calendarId: "primary@x.com" });

    await syncWorkspace(deps(), u.workspaceId);
    expect(await localEvents(u.workspaceId)).toHaveLength(1);
  });

  it("se o Google gravou mas a resposta se perdeu, o reenvio não duplica", async () => {
    const u = await makeUser();
    await connect(u);
    const created = await json(await call(u, "POST", "/api/events", { title: "Call", startAt: "2026-10-08T10:00", endAt: "2026-10-08T11:00" }));
    g.put("primary@x.com", { id: googleIdFor(created.id), summary: "Call", start: { dateTime: "2026-10-08T13:00:00Z" }, end: { dateTime: "2026-10-08T14:00:00Z" } });
    await processJobs(deps());
    expect(g.store("primary@x.com").size).toBe(1);
    const writes = g.calls.filter((c) => c.path.startsWith("/calendar") && c.method !== "GET").map((c) => c.method);
    expect(writes).toEqual(["POST", "PATCH"]);
    expect((await json(await call(u, "GET", `/api/events/${created.id}`))).syncStatus).toBe("synced");
  });

  it("edições seguidas viram um envio só; exclusão remove no Google", async () => {
    const u = await makeUser();
    await connect(u);
    const created = await json(await call(u, "POST", "/api/events", { title: "Rascunho", startAt: "2026-10-09T10:00", endAt: "2026-10-09T11:00" }));
    await call(u, "PATCH", `/api/events/${created.id}`, { title: "Versão final" });
    const jobs = await db().select().from(syncJobs).where(eq(syncJobs.eventId, created.id));
    expect(jobs).toHaveLength(1);
    await processJobs(deps());
    expect(g.calls.filter((c) => c.method === "POST" && c.path.startsWith("/calendar"))).toHaveLength(1);
    expect(g.store("primary@x.com").get(googleIdFor(created.id))!.summary).toBe("Versão final");

    await call(u, "PATCH", `/api/events/${created.id}`, { startAt: "2026-10-09T15:00", endAt: "2026-10-09T16:00" });
    await processJobs(deps());
    expect(g.calls.at(-1)!.method).toBe("PATCH");
    expect(g.store("primary@x.com").get(googleIdFor(created.id))!.start!.dateTime).toBe("2026-10-09T18:00:00.000Z");

    expect((await call(u, "DELETE", `/api/events/${created.id}`)).status).toBe(204);
    await processJobs(deps());
    expect(g.store("primary@x.com").get(googleIdFor(created.id))!.status).toBe("cancelled");
  });

  it("excluir antes de enviar só descarta a fila", async () => {
    const u = await makeUser();
    await connect(u);
    const created = await json(await call(u, "POST", "/api/events", { title: "Engano", startAt: "2026-10-09T10:00", endAt: "2026-10-09T11:00" }));
    await call(u, "DELETE", `/api/events/${created.id}`);
    expect(await db().select().from(syncJobs).where(eq(syncJobs.eventId, created.id))).toHaveLength(0);
    await processJobs(deps());
    expect(g.calls.filter((c) => c.path.startsWith("/calendar") && c.method !== "GET")).toHaveLength(0);
  });

  it("falha transitória volta com backoff; falha permanente marca erro", async () => {
    const u = await makeUser();
    await connect(u);
    const a = await json(await call(u, "POST", "/api/events", { title: "Com 503", startAt: "2026-10-10T10:00", endAt: "2026-10-10T11:00" }));
    g.failNext.set("POST primary@x.com", 503);
    const t0 = Date.now();
    expect(await processJobs(deps(() => t0), { workspaceId: u.workspaceId })).toEqual({ done: 0, retried: 1, failed: 0 });
    const job = (await db().query.syncJobs.findFirst({ where: eq(syncJobs.eventId, a.id) }))!;
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job.nextAttemptAt).toBe(t0 + 60_000);
    expect((await json(await call(u, "GET", `/api/events/${a.id}`))).syncStatus).toBe("pending");
    // Antes do horário marcado não tenta de novo.
    expect(await processJobs(deps(() => t0 + 1000), { workspaceId: u.workspaceId })).toEqual({ done: 0, retried: 0, failed: 0 });
    expect(await processJobs(deps(() => t0 + 61_000), { workspaceId: u.workspaceId })).toEqual({ done: 1, retried: 0, failed: 0 });

    const b = await json(await call(u, "POST", "/api/events", { title: "Com 403", startAt: "2026-10-10T12:00", endAt: "2026-10-10T13:00" }));
    g.failNext.set("POST primary@x.com", 403);
    expect(await processJobs(deps(), { workspaceId: u.workspaceId })).toEqual({ done: 0, retried: 0, failed: 1 });
    expect((await json(await call(u, "GET", `/api/events/${b.id}`))).syncStatus).toBe("error");
    // Uma nova edição volta a colocar na fila.
    await call(u, "PATCH", `/api/events/${b.id}`, { title: "Com 403 corrigido" });
    expect(await processJobs(deps(), { workspaceId: u.workspaceId })).toEqual({ done: 1, retried: 0, failed: 0 });
  });

  it("token revogado marca a conta e a fila espera a reconexão", async () => {
    const u = await makeUser();
    await connect(u);
    await db().update(integrationAccounts).set({ accessTokenExpiresAt: 0 }).where(eq(integrationAccounts.workspaceId, u.workspaceId));
    const ev = await json(await call(u, "POST", "/api/events", { title: "X", startAt: "2026-10-10T10:00", endAt: "2026-10-10T11:00" }));
    g.tokenRevoked = true;
    await processJobs(deps());
    const status = await json(await call(u, "GET", "/api/integrations/google"));
    expect(status).toMatchObject({ connected: true, status: "revoked", pendingJobs: 1 });
    expect(status.lastError).toMatch(/revogado/);
    expect((await db().query.syncJobs.findFirst({ where: eq(syncJobs.eventId, ev.id) }))!.status).toBe("pending");
    // Com a conta revogada, novas alterações ficam só locais.
    const other = await json(await call(u, "POST", "/api/events", { title: "Y", startAt: "2026-10-11T10:00", endAt: "2026-10-11T11:00" }));
    expect(other.syncStatus).toBe("local");
  });

  it("alteração local na fila não é sobrescrita pelo Google", async () => {
    const u = await makeUser();
    const account = await connect(u);
    g.put("primary@x.com", { id: "c1", summary: "Original", start: { dateTime: "2026-10-05T14:00:00Z" }, end: { dateTime: "2026-10-05T15:00:00Z" } });
    await syncCalendar(deps(), account, await primaryCal(account.id));
    const [local] = await localEvents(u.workspaceId);
    await call(u, "PATCH", `/api/events/${local.id}`, { title: "Editado aqui" });
    g.put("primary@x.com", { ...g.store("primary@x.com").get("c1")!, summary: "Editado lá" });
    await syncCalendar(deps(), account, await primaryCal(account.id));
    expect((await localEvents(u.workspaceId))[0].title).toBe("Editado aqui");
    await processJobs(deps());
    expect(g.store("primary@x.com").get("c1")!.summary).toBe("Editado aqui");
  });
});

describe("agenda só de leitura", () => {
  it("editar evento de agenda só de leitura não tenta enviar ao Google", async () => {
    const u = await makeUser();
    const account = await connect(u);
    await db().update(calendars).set({ selected: true }).where(eq(calendars.googleCalendarId, "feriados@x.com"));
    g.put("feriados@x.com", { id: "h1", summary: "Feriado", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } });
    await syncWorkspace(deps(), u.workspaceId);
    const [ev] = await localEvents(u.workspaceId);
    const res = await json(await call(u, "PATCH", `/api/events/${ev.id}`, { title: "Feriado (anotado)" }));
    expect(res.syncStatus).toBe("synced");
    expect(await db().select().from(syncJobs).where(eq(syncJobs.eventId, ev.id))).toHaveLength(0);
    void account;
  });
});

describe("API de integração", () => {
  it("mostra status, troca agendas e respeita papéis e workspaces", async () => {
    const owner = await makeUser();
    const member = await makeUser({ workspaceId: owner.workspaceId, role: "member" });
    const stranger = await makeUser();
    expect(await json(await call(owner, "GET", "/api/integrations/google"))).toEqual({ connected: false });
    await connect(owner);

    const status = await json(await call(member, "GET", "/api/integrations/google"));
    expect(status).toMatchObject({ connected: true, email: "dono@gmail.com", status: "active", defaultCalendarId: "primary@x.com" });
    expect(status.calendars.map((c: any) => c.summary)).toEqual(["Pessoal", "Feriados", "Trabalho"]);
    expect(JSON.stringify(status)).not.toMatch(/refresh|Enc/);
    expect(await json(await call(stranger, "GET", "/api/integrations/google"))).toEqual({ connected: false });

    expect((await call(member, "PATCH", "/api/integrations/google", { defaultCalendarId: "trabalho@x.com" })).status).toBe(403);
    expect((await call(owner, "PATCH", "/api/integrations/google", { defaultCalendarId: "feriados@x.com" })).status).toBe(400);
    const updated = await json(
      await call(owner, "PATCH", "/api/integrations/google", { defaultCalendarId: "trabalho@x.com", calendars: [{ id: "trabalho@x.com", selected: true }] }),
    );
    expect(updated.defaultCalendarId).toBe("trabalho@x.com");
    expect(updated.calendars.find((c: any) => c.id === "trabalho@x.com").selected).toBe(true);

    expect((await call(member, "DELETE", "/api/integrations/google")).status).toBe(403);
  });

  it("desconectar revoga o token, apaga a conta e tira a fila", async () => {
    const u = await makeUser();
    await connect(u);
    const ev = await json(await call(u, "POST", "/api/events", { title: "Fica", startAt: "2026-10-10T10:00", endAt: "2026-10-10T11:00" }));
    expect((await call(u, "DELETE", "/api/integrations/google")).status).toBe(204);
    const revoke = g.calls.find((c) => c.path === "/revoke")!;
    expect(revoke.body.token).toBe("refresh-secreto");
    expect(await json(await call(u, "GET", "/api/integrations/google"))).toEqual({ connected: false });
    expect(await db().select().from(syncJobs).where(eq(syncJobs.workspaceId, u.workspaceId))).toHaveLength(0);
    expect((await json(await call(u, "GET", `/api/events/${ev.id}`))).syncStatus).toBe("local");
  });

  it("botão sincronizar envia a fila e importa", async () => {
    const u = await makeUser();
    await connect(u);
    g.put("primary@x.com", { id: "d1", summary: "Do Google", start: { dateTime: "2026-10-05T14:00:00Z" }, end: { dateTime: "2026-10-05T15:00:00Z" } });
    await call(u, "POST", "/api/events", { title: "Daqui", startAt: "2026-10-06T10:00", endAt: "2026-10-06T11:00" });
    const res = await json(await call(u, "POST", "/api/integrations/google/sync", {}));
    expect(res.result.jobs.done).toBe(1);
    expect(res.lastSyncAt).toBeTruthy();
    const titles = (await json(await call(u, "GET", "/api/events"))).map((e: any) => e.title).sort();
    expect(titles).toEqual(["Daqui", "Do Google"]);
  });
});

describe("conexão OAuth do Google Agenda", () => {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events";

  async function start(u: TestUser) {
    const res = await call(u, "GET", "/integrations/google/connect");
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    const tx = JSON.parse(atob(decodeURIComponent(cookie.split("=").slice(1).join("="))));
    return { url, cookie, tx };
  }

  function grant(tx: any, scope: string, refresh = "rt-novo") {
    g.onCode = (body) => {
      expect(body.code_verifier).toBe(tx.verifier);
      expect(body.redirect_uri).toBe("https://app.test/integrations/google/callback");
      return {
        id_token: `${enc({ alg: "RS256" })}.${enc({ iss: "https://accounts.google.com", aud: "client-test", exp: Math.floor(Date.now() / 1000) + 600, nonce: tx.nonce, sub: "g-agenda", email: "agenda@gmail.com", email_verified: true })}.sig`,
        access_token: "at-novo",
        refresh_token: refresh,
        expires_in: 3600,
        scope,
      };
    };
  }

  it("pede acesso offline só aos escopos do Agenda, grava tokens cifrados e lista as agendas", async () => {
    const u = await makeUser();
    const { url, cookie, tx } = await start(u);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(`openid email ${SCOPES.split(" ").slice(2).join(" ")} https://www.googleapis.com/auth/drive.file`);
    expect(url.searchParams.get("scope")).not.toMatch(/auth\/drive( |$)/);
    expect(url.searchParams.get("login_hint")).toBe(`${u.id}@exemplo.com`);

    grant(tx, SCOPES);
    const res = await call(u, "GET", `/integrations/google/callback?code=abc&state=${tx.state}`, undefined, { cookie: `${u.cookie}; ${cookie}` });
    expect(res.headers.get("location")).toBe("/configuracoes?google=conectado");

    const account = (await db().query.integrationAccounts.findFirst({ where: eq(integrationAccounts.workspaceId, u.workspaceId) }))!;
    expect(account.email).toBe("agenda@gmail.com");
    expect(account.refreshTokenEnc).not.toContain("rt-novo");
    expect(await decryptSecret(account.refreshTokenEnc, KEY)).toBe("rt-novo");
    const status = await json(await call(u, "GET", "/api/integrations/google"));
    expect(status.calendars).toHaveLength(3);
  });

  it("recusa quando a pessoa desmarca permissões ou o state não confere", async () => {
    const u = await makeUser();
    const first = await start(u);
    grant(first.tx, "openid https://www.googleapis.com/auth/calendar.events");
    const res = await call(u, "GET", `/integrations/google/callback?code=abc&state=${first.tx.state}`, undefined, { cookie: `${u.cookie}; ${first.cookie}` });
    expect(res.headers.get("location")).toBe("/configuracoes?google=escopos");

    const second = await start(u);
    const bad = await call(u, "GET", "/integrations/google/callback?code=abc&state=outro", undefined, { cookie: `${u.cookie}; ${second.cookie}` });
    expect(bad.headers.get("location")).toBe("/configuracoes?google=expirado");
    expect(await json(await call(u, "GET", "/api/integrations/google"))).toEqual({ connected: false });
  });

  it("só dono ou administrador conecta", async () => {
    const owner = await makeUser();
    const member = await makeUser({ workspaceId: owner.workspaceId, role: "member" });
    expect((await call(member, "GET", "/integrations/google/connect")).status).toBe(403);
  });
});
