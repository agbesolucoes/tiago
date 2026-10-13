import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptions, tasks, telegramLinks } from "../src/db/schema";
import { sendReminders } from "../src/integrations/reminders";
import { telegramFetch } from "../src/integrations/telegram-client";
import { base64url, newId } from "../src/lib/crypto";
import { parseDateTime } from "../src/lib/time";
import { encryptPayload, fromBase64url, generateVapidKeys, pushFetch, vapidAuthorization } from "../src/lib/webpush";
import { call, db, json, makeUser, type TestUser } from "./helpers";

const TZ = "America/Sao_Paulo";
const at = (local: string) => parseDateTime(local, TZ)!;

/** Um navegador de mentira: tem as próprias chaves e sabe decifrar o que recebe (lado do RFC 8291 que o navegador faz). */
async function fakeBrowser(host = "fcm.googleapis.com") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = base64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
  const auth = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const endpoint = `https://${host}/fcm/send/${newId()}`;
  async function decrypt(body: Uint8Array) {
    const salt = body.slice(0, 16);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    const cipher = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as any, pair.privateKey, 256));
    const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
      new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), n * 8));
    const te = new TextEncoder();
    const ua = fromBase64url(p256dh);
    const info = new Uint8Array([...te.encode("WebPush: info\0"), ...ua, ...asPublic]);
    const ikm = await hkdf(fromBase64url(auth), secret, info, 32);
    const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, cipher));
    expect(plain.at(-1)).toBe(2);
    return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
  }
  return { endpoint, keys: { p256dh, auth }, decrypt };
}

type Browser = Awaited<ReturnType<typeof fakeBrowser>>;

/** Serviço de push de mentira: decifra e guarda cada alerta; `status` muda a resposta. */
let inbox: { endpoint: string; message: any; headers: Headers }[];
let browsers: Map<string, Browser>;
let status: number;
const realPush = pushFetch.impl;
beforeEach(() => {
  inbox = [];
  browsers = new Map();
  status = 201;
  pushFetch.impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input);
    const b = browsers.get(endpoint)!;
    inbox.push({ endpoint, message: await b.decrypt(new Uint8Array(init!.body as ArrayBuffer)), headers: new Headers(init!.headers) });
    return new Response(null, { status });
  }) as typeof fetch;
});
afterEach(() => {
  pushFetch.impl = realPush;
});

async function addDevice(u: TestUser, host?: string) {
  const b = await fakeBrowser(host);
  browsers.set(b.endpoint, b);
  const res = await call(u, "POST", "/api/notifications/devices", { endpoint: b.endpoint, keys: b.keys, label: "Chrome no Windows" });
  expect(res.status).toBe(201);
  return b;
}

describe("Web Push", () => {
  it("cifra para o navegador e assina o VAPID para a origem do serviço", async () => {
    const b = await fakeBrowser();
    const body = await encryptPayload(b.keys, new TextEncoder().encode(JSON.stringify({ oi: "ç" })));
    expect(await b.decrypt(body)).toEqual({ oi: "ç" });

    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(b.endpoint, keys, "https://app.test", Date.UTC(2026, 9, 1));
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, sig] = token.split(".");
    const claims = JSON.parse(atob(c.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://app.test" });
    const pub = await crypto.subtle.importKey("raw", fromBase64url(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromBase64url(sig), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });

  it("registra aparelhos só de serviços de push conhecidos, um por navegador", async () => {
    const u = await makeUser();
    const first = await json(await call(u, "GET", "/api/notifications"));
    expect(first.push.enabled).toBe(true);
    expect(fromBase64url(first.push.publicKey)).toHaveLength(65);
    expect((await json(await call(u, "GET", "/api/notifications"))).push.publicKey).toBe(first.push.publicKey);

    const b = await fakeBrowser();
    expect((await call(u, "POST", "/api/notifications/devices", { endpoint: "https://169.254.169.254/x", keys: b.keys })).status).toBe(400);
    expect((await call(u, "POST", "/api/notifications/devices", { endpoint: b.endpoint, keys: { ...b.keys, auth: "abc" } })).status).toBe(400);
    await addDevice(u);
    const dev = await addDevice(u, "web.push.apple.com");
    // O mesmo navegador de novo não duplica.
    await call(u, "POST", "/api/notifications/devices", { endpoint: dev.endpoint, keys: dev.keys });
    const list = (await json(await call(u, "GET", "/api/notifications"))).devices;
    expect(list).toHaveLength(2);

    // Outra pessoa não vê nem apaga os aparelhos de quem ativou.
    const other = await makeUser({ workspaceId: u.workspaceId, role: "admin" });
    expect((await json(await call(other, "GET", "/api/notifications"))).devices).toHaveLength(0);
    expect((await call(other, "DELETE", `/api/notifications/devices/${list[0].id}`)).status).toBe(404);
    expect((await call(u, "DELETE", `/api/notifications/devices/${list[0].id}`)).status).toBe(204);
  });

  it("manda o alerta de teste e esquece aparelho cancelado", async () => {
    const u = await makeUser();
    const b = await addDevice(u);
    const r = await json(await call(u, "POST", "/api/notifications/test", {}));
    expect(r).toEqual({ sent: 1, devices: 1 });
    expect(inbox[0].message).toMatchObject({ title: "Central de Organização", url: "/configuracoes" });
    expect(inbox[0].headers.get("content-encoding")).toBe("aes128gcm");
    expect(inbox[0].headers.get("authorization")).toMatch(/^vapid t=/);

    status = 410;
    expect(await json(await call(u, "POST", "/api/notifications/test", {}))).toEqual({ sent: 0, devices: 1 });
    expect(await db().select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, b.endpoint))).toHaveLength(0);
  });
});

describe("avisos de tarefas e compromissos", () => {
  const run = (local: string) => sendReminders({ db: db(), env, now: () => at(local) });

  it("tarefa avisa no prazo por padrão, para o responsável, uma vez", async () => {
    const dono = await makeUser();
    const resp = await makeUser({ workspaceId: dono.workspaceId, role: "member" });
    await addDevice(dono);
    await addDevice(resp);
    const t = await json(await call(dono, "POST", "/api/tasks", { title: "Enviar proposta", dueAt: "2026-10-20T15:00", assigneeId: resp.id }));
    expect(t.reminderMinutes).toBe(0);

    await run("2026-10-20T14:58");
    expect(inbox).toHaveLength(0);
    await run("2026-10-20T15:01");
    await run("2026-10-20T15:04");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message).toMatchObject({ title: "Tarefa: Enviar proposta", body: "Prazo hoje às 15:00", url: "/tarefas" });
    expect(browsers.get(inbox[0].endpoint)).toBeDefined();
    const [row] = await db().select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, inbox[0].endpoint));
    expect(row.userId).toBe(resp.id);

    // Prazo adiado: avisa de novo no novo prazo.
    await call(dono, "PATCH", `/api/tasks/${t.id}`, { dueAt: "2026-10-21T10:00", reminderMinutes: 60 });
    await run("2026-10-21T09:01");
    expect(inbox).toHaveLength(2);
    expect(inbox[1].message.body).toBe("Prazo hoje às 10:00");
  });

  it("tarefa só com data avisa às 9h; concluída ou sem lembrete não avisa", async () => {
    const u = await makeUser();
    await addDevice(u);
    await call(u, "POST", "/api/tasks", { title: "Pagar boleto", dueAt: "2026-10-22" });
    await call(u, "POST", "/api/tasks", { title: "Já feita", dueAt: "2026-10-22", status: "done" });
    await call(u, "POST", "/api/tasks", { title: "Sem aviso", dueAt: "2026-10-22", reminderMinutes: null });
    const dayBefore = await json(await call(u, "POST", "/api/tasks", { title: "Renovar seguro", dueAt: "2026-10-23", reminderMinutes: 1440 }));
    await run("2026-10-22T08:00");
    expect(inbox).toHaveLength(0);
    await run("2026-10-22T09:02");
    expect(inbox.map((m) => m.message.title).sort()).toEqual(["Tarefa: Pagar boleto", "Tarefa: Renovar seguro"]);
    expect(inbox.find((m) => m.message.title === "Tarefa: Renovar seguro")!.message.body).toBe("Prazo amanhã");
    expect(dayBefore.reminderMinutes).toBe(1440);
  });

  it("compromisso avisa todos com alertas e mantém o Telegram", async () => {
    const sent: any[] = [];
    const realTg = telegramFetch.impl;
    telegramFetch.impl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch;
    try {
      const u = await makeUser();
      const m = await makeUser({ workspaceId: u.workspaceId, role: "member" });
      await addDevice(u);
      await addDevice(m);
      await db().insert(telegramLinks).values({ id: newId(), workspaceId: u.workspaceId, userId: u.id, telegramUserId: String(Math.random()), chatId: "77" });
      await call(u, "POST", "/api/events", { title: "Reunião com o corretor", startAt: "2026-10-20T10:00", endAt: "2026-10-20T11:00", reminderMinutes: 30 });
      await run("2026-10-20T09:31");
      await run("2026-10-20T09:36");
      expect(inbox).toHaveLength(2);
      expect(inbox[0].message).toMatchObject({ title: "Reunião com o corretor", body: "Hoje às 10:00 (em 30 minutos)", url: "/agenda" });
      expect(sent.filter((s) => s.chat_id === "77")).toEqual([expect.objectContaining({ text: "Lembrete: Reunião com o corretor às 10:00 (em 30 minutos)" })]);
    } finally {
      telegramFetch.impl = realTg;
    }
  });

  it("falha no serviço de push tenta de novo no ciclo seguinte", async () => {
    const u = await makeUser();
    await addDevice(u);
    await call(u, "POST", "/api/tasks", { title: "Ligar para o síndico", dueAt: "2026-10-20T16:00" });
    status = 500;
    await run("2026-10-20T16:01");
    status = 201;
    await run("2026-10-20T16:06");
    expect(inbox.map((m) => m.message.title)).toEqual(["Tarefa: Ligar para o síndico", "Tarefa: Ligar para o síndico"]);
    await run("2026-10-20T16:11");
    expect(inbox).toHaveLength(2);
    const [row] = await db().select().from(tasks).where(eq(tasks.title, "Ligar para o síndico"));
    expect(row.reminderMinutes).toBe(0);
  });
});
