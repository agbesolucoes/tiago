import { base64url } from "./crypto";

// AES-256-GCM com chave de TOKEN_ENCRYPTION_KEY (32 bytes em base64). Formato: v1.<iv>.<cifra>

async function importKey(rawBase64: string) {
  const raw = Uint8Array.from(atob(rawBase64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY precisa ter 32 bytes em base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function fromB64url(s: string) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export async function encryptSecret(plain: string, keyBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyBase64), new TextEncoder().encode(plain));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(data))}`;
}

export async function decryptSecret(sealed: string, keyBase64: string): Promise<string> {
  const [v, iv, data] = sealed.split(".");
  if (v !== "v1" || !iv || !data) throw new Error("segredo em formato desconhecido");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) }, await importKey(keyBase64), fromB64url(data));
  return new TextDecoder().decode(plain);
}
