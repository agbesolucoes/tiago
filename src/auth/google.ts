import { base64url, base64urlDecode, randomToken } from "../lib/crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface LoginTransaction {
  state: string;
  verifier: string;
  nonce: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

export function redirectUri(appUrl: string): string {
  return new URL("/auth/callback", appUrl).toString();
}

export async function startLogin(clientId: string, appUrl: string) {
  const tx: LoginTransaction = { state: randomToken(), verifier: randomToken(48), nonce: randomToken() };
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tx.verifier))),
  );
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(appUrl),
    response_type: "code",
    // Só identidade. Calendar e Drive serão uma autorização separada.
    scope: "openid email profile",
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), tx };
}

export class AuthError extends Error {}

/**
 * Troca o código pelo id_token direto no endpoint do Google (TLS), o que dispensa
 * verificar a assinatura (OpenID Connect Core 3.1.3.7). As claims são validadas.
 */
export async function finishLogin(opts: {
  code: string;
  tx: LoginTransaction;
  clientId: string;
  clientSecret: string;
  appUrl: string;
  fetcher?: typeof fetch;
}): Promise<GoogleIdentity> {
  const res = await (opts.fetcher ?? fetch)(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: redirectUri(opts.appUrl),
      grant_type: "authorization_code",
      code_verifier: opts.tx.verifier,
    }),
  });
  if (!res.ok) throw new AuthError(`token endpoint ${res.status}`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new AuthError("id_token ausente");

  const parts = body.id_token.split(".");
  if (parts.length !== 3) throw new AuthError("id_token malformado");
  const claims = JSON.parse(base64urlDecode(parts[1])) as Record<string, unknown>;

  if (!ISSUERS.has(String(claims.iss))) throw new AuthError("iss inválido");
  if (claims.aud !== opts.clientId) throw new AuthError("aud inválido");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new AuthError("token expirado");
  if (claims.nonce !== opts.tx.nonce) throw new AuthError("nonce inválido");
  if (claims.email_verified !== true || typeof claims.email !== "string") throw new AuthError("e-mail não verificado");
  if (typeof claims.sub !== "string") throw new AuthError("sub ausente");

  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === "string" ? claims.name : null,
  };
}
