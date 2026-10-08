// Web Push (RFC 8291 + RFC 8292) só com WebCrypto, para rodar igual na Cloudflare e no Node.
// O conteúdo vai cifrado (aes128gcm) para a chave do navegador; o serviço de push só repassa.
import { base64url } from "./crypto";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  /** Chave pública P-256 sem compressão (65 bytes), em base64url: vai para o navegador como applicationServerKey. */
  publicKey: string;
  /** JWK da chave privada (ECDSA P-256). */
  privateJwk: JsonWebKey;
}

/** `pushFetch.impl` é trocado nos testes. */
export const pushFetch: { impl: typeof fetch } = { impl: (input, init) => fetch(input, init) };

const enc = new TextEncoder();

export function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return { publicKey: base64url(raw), privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey };
}

/** Cabeçalho Authorization do VAPID (RFC 8292): JWT ES256 para a origem do serviço de push. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()) {
  const header = base64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // A assinatura ECDSA do WebCrypto já sai no formato r||s de 64 bytes que o JWS pede.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${base64url(sig)}, k=${keys.publicKey}`;
}

/** Cifra o conteúdo para um navegador (RFC 8291, "aes128gcm", um único registro). */
export async function encryptPayload(target: Pick<PushTarget, "p256dh" | "auth">, payload: Uint8Array, opts: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {}) {
  const uaPublic = fromBase64url(target.p256dh);
  const authSecret = fromBase64url(target.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("chaves do navegador inválidas");
  const server = opts.serverKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", server.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, server.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Delimitador 0x02: último (e único) registro.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

export type PushResult = "ok" | "gone" | "failed";

/** Envia uma notificação. "gone" = o navegador cancelou a inscrição (404/410) e ela deve ser apagada. */
export async function sendPush(target: PushTarget, message: unknown, keys: VapidKeys, subject: string, ttlSeconds = 3600): Promise<{ result: PushResult; status: number }> {
  const body = await encryptPayload(target, enc.encode(JSON.stringify(message)));
  const res = await pushFetch.impl(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
      Urgency: "high",
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return { result: "gone", status: res.status };
  return { result: res.ok ? "ok" : "failed", status: res.status };
}

/** Serviços de push dos navegadores. O servidor só manda requisições para estes endereços. */
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "push.services.mozilla.com", "web.push.apple.com", "notify.windows.com"];

export function isPushEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}
