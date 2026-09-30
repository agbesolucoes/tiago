import { env, SELF } from "cloudflare:test";
import { createSession } from "../src/auth/session";
import { getDb } from "../src/db/client";
import { memberships, users, workspaces, type Role } from "../src/db/schema";
import { newId } from "../src/lib/crypto";

export const db = () => getDb(env.DB);

export interface TestUser {
  id: string;
  workspaceId: string;
  cookie: string;
}

/** Cria usuário com sessão. Sem workspaceId, ganha um workspace próprio como owner. */
export async function makeUser(opts: { workspaceId?: string; role?: Role } = {}): Promise<TestUser> {
  const id = newId();
  await db().insert(users).values({ id, email: `${id}@exemplo.com` });
  let workspaceId = opts.workspaceId;
  if (!workspaceId) {
    workspaceId = newId();
    await db().insert(workspaces).values({ id: workspaceId, name: "Teste" });
  }
  await db().insert(memberships).values({ workspaceId, userId: id, role: opts.role ?? "owner" });
  const token = await createSession(db(), id);
  return { id, workspaceId, cookie: `sid=${token}` };
}

export function call(user: TestUser | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://app.test${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(user && { cookie: user.cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
