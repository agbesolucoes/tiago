import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { finishLogin, type LoginTransaction } from "../src/auth/google";
import { AccessDenied, upsertUser } from "../src/auth/session";
import { base64url } from "../src/lib/crypto";
import { call, db, json } from "./helpers";

const tx: LoginTransaction = { state: "s", verifier: "v".repeat(64), nonce: "n1" };

function idToken(claims: Record<string, unknown>) {
  const enc = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc(claims)}.assinatura`;
}

const good = {
  iss: "https://accounts.google.com",
  aud: "client-test",
  exp: Math.floor(Date.now() / 1000) + 3600,
  nonce: "n1",
  sub: "google-123",
  email: "Dono@Exemplo.com",
  email_verified: true,
  name: "Dono",
};

function fakeGoogle(claims: Record<string, unknown>) {
  let sent: URLSearchParams | null = null;
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent = new URLSearchParams(init.body as string);
    return Response.json({ id_token: idToken(claims) });
  }) as unknown as typeof fetch;
  return { fetcher, sent: () => sent! };
}

const login = (claims: Record<string, unknown>) =>
  finishLogin({ code: "c", tx, clientId: "client-test", clientSecret: "secret-test", appUrl: "https://app.test", fetcher: fakeGoogle(claims).fetcher });

describe("login Google", () => {
  it("redireciona para o Google com PKCE, state e só escopos de identidade", async () => {
    const res = await SELF.fetch("https://app.test/auth/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/auth/callback");
    expect(url.searchParams.get("state")).toBeTruthy();
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/oauth_tx=.*HttpOnly/);
    expect(cookie).toMatch(/Secure/);
  });

  it("callback com state diferente é recusado", async () => {
    const start = await SELF.fetch("https://app.test/auth/login", { redirect: "manual" });
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const res = await SELF.fetch("https://app.test/auth/callback?code=c&state=outro", { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?erro=expirado");
    expect(res.headers.get("set-cookie")).not.toMatch(/sid=/);
  });

  it("aceita id_token válido e envia o code_verifier", async () => {
    const g = fakeGoogle(good);
    const id = await finishLogin({ code: "c", tx, clientId: "client-test", clientSecret: "secret-test", appUrl: "https://app.test", fetcher: g.fetcher });
    expect(id).toEqual({ sub: "google-123", email: "dono@exemplo.com", name: "Dono" });
    expect(g.sent().get("code_verifier")).toBe(tx.verifier);
    expect(g.sent().get("grant_type")).toBe("authorization_code");
  });

  it.each([
    ["nonce", { nonce: "outro" }],
    ["aud", { aud: "outro-client" }],
    ["iss", { iss: "https://evil.com" }],
    ["exp", { exp: 1000 }],
    ["email_verified", { email_verified: false }],
  ])("recusa id_token com %s inválido", async (_name, override) => {
    await expect(login({ ...good, ...override })).rejects.toThrow();
  });
});

describe("login de desenvolvimento", () => {
  it("fica desligado sem DEV_LOGIN", async () => {
    const res = await SELF.fetch("http://localhost/auth/dev-login?email=dono@exemplo.com", { redirect: "manual" });
    expect(res.status).toBe(404);
  });
});

describe("acesso", () => {
  it("só e-mails autorizados entram; o primeiro vira owner e o seguinte entra como membro", async () => {
    const allowed = "dono@exemplo.com,membro@exemplo.com";
    await expect(upsertUser(db(), { sub: "x", email: "intruso@exemplo.com", name: null }, allowed)).rejects.toBeInstanceOf(AccessDenied);

    const owner = await upsertUser(db(), { sub: "g1", email: "dono@exemplo.com", name: "Dono" }, allowed);
    const member = await upsertUser(db(), { sub: "g2", email: "membro@exemplo.com", name: null }, allowed);
    const rows = await db().query.memberships.findMany();
    const ownerRow = rows.find((r) => r.userId === owner.id)!;
    const memberRow = rows.find((r) => r.userId === member.id)!;
    expect(ownerRow.role).toBe("owner");
    expect(memberRow.role).toBe("member");
    expect(memberRow.workspaceId).toBe(ownerRow.workspaceId);

    // Mesmo e-mail com outra conta Google é recusado.
    await expect(upsertUser(db(), { sub: "outro", email: "dono@exemplo.com", name: null }, allowed)).rejects.toBeInstanceOf(AccessDenied);
    // Novo login da mesma conta não duplica.
    await upsertUser(db(), { sub: "g1", email: "dono@exemplo.com", name: "Dono" }, allowed);
    expect(await db().query.users.findMany()).toHaveLength(2);
  });

  it("logout invalida a sessão", async () => {
    const owner = await upsertUser(db(), { sub: "g9", email: "outro@exemplo.com", name: null }, "outro@exemplo.com");
    const { createSession } = await import("../src/auth/session");
    const cookie = `sid=${await createSession(db(), owner.id)}`;
    const u = { id: owner.id, workspaceId: "", cookie };
    expect((await call(u, "GET", "/api/me")).status).toBe(200);
    expect((await json(await call(u, "GET", "/api/me"))).workspace.role).toBe("owner");
    await call(u, "POST", "/auth/logout");
    expect((await call(u, "GET", "/api/me")).status).toBe(401);
  });
});
