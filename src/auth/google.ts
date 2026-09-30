import { googleFetch } from "../integrations/google-client";
import { base64url, base64urlDecode, randomToken } from "../lib/crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export const LOGIN_REDIRECT_PATH = "/auth/callback";
export const CALENDAR_REDIRECT_PATH = "/integrations/google/callback";
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

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

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

export function redirectUri(appUrl: string, path = LOGIN_REDIRECT_PATH): string {
  return new URL(path, appUrl).toString();
}

/** Monta a URL de autorização (Authorization Code + PKCE + state + nonce). */
export async function startAuthorization(opts: {
  clientId: string;
  appUrl: string;
  redirectPath: string;
  scopes: string[];
  /** Pede refresh_token (acesso offline) e mostra o consentimento de novo. */
  offline?: boolean;
  loginHint?: string;
}) {
  const tx: LoginTransaction = { state: randomToken(), verifier: randomToken(48), nonce: randomToken() };
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tx.verifier))));
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: redirectUri(opts.appUrl, opts.redirectPath),
    response_type: "code",
    scope: ["openid", "email", ...opts.scopes].join(" "),
    state: tx.state,
    nonce: tx.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(opts.offline ? { access_type: "offline", prompt: "consent", include_granted_scopes: "true" } : { prompt: "select_account" }),
    ...(opts.loginHint && { login_hint: opts.loginHint }),
  }).toString();
  return { url: url.toString(), tx };
}

export function startLogin(clientId: string, appUrl: string) {
  // Só identidade. Calendar e Drive são uma autorização separada.
  return startAuthorization({ clientId, appUrl, redirectPath: LOGIN_REDIRECT_PATH, scopes: ["profile"] });
}

export class AuthError extends Error {}

/**
 * Troca o código pelos tokens direto no endpoint do Google (TLS), o que dispensa
 * verificar a assinatura do id_token (OpenID Connect Core 3.1.3.7). As claims são validadas.
 */
export async function exchangeCode(opts: {
  code: string;
  tx: LoginTransaction;
  clientId: string;
  clientSecret: string;
  appUrl: string;
  redirectPath?: string;
  fetcher?: typeof fetch;
}): Promise<{ identity: GoogleIdentity; tokens: GoogleTokens }> {
  const res = await (opts.fetcher ?? googleFetch.impl)(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: redirectUri(opts.appUrl, opts.redirectPath),
      grant_type: "authorization_code",
      code_verifier: opts.tx.verifier,
    }),
  });
  if (!res.ok) throw new AuthError(`token endpoint ${res.status}`);
  const body = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
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
    identity: {
      sub: claims.sub,
      email: claims.email.toLowerCase(),
      name: typeof claims.name === "string" ? claims.name : null,
    },
    tokens: {
      accessToken: body.access_token ?? "",
      refreshToken: body.refresh_token ?? null,
      expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
      scopes: (body.scope ?? "").split(" ").filter(Boolean),
    },
  };
}

export async function finishLogin(opts: Parameters<typeof exchangeCode>[0]): Promise<GoogleIdentity> {
  return (await exchangeCode(opts)).identity;
}
