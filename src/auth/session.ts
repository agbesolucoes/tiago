import { and, asc, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { memberships, sessions, users, workspaces } from "../db/schema";
import { newId, randomToken, sha256 } from "../lib/crypto";
import type { GoogleIdentity } from "./google";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function allowedEmails(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export class AccessDenied extends Error {}

/**
 * Cria ou atualiza o usuário após o login. Só e-mails da lista entram.
 * No primeiro acesso de todos cria o workspace inicial; o primeiro e-mail da lista é owner.
 */
export async function upsertUser(db: Db, identity: GoogleIdentity, allowedRaw: string) {
  const allowed = allowedEmails(allowedRaw);
  if (!allowed.includes(identity.email)) throw new AccessDenied("e-mail não autorizado");

  let user = await db.query.users.findFirst({ where: eq(users.email, identity.email) });
  if (user?.googleSub && user.googleSub !== identity.sub) throw new AccessDenied("conta Google diferente");

  if (!user) {
    const id = newId();
    await db.insert(users).values({ id, email: identity.email, name: identity.name, googleSub: identity.sub });
    user = (await db.query.users.findFirst({ where: eq(users.id, id) }))!;
  } else if (!user.googleSub) {
    await db.update(users).set({ googleSub: identity.sub, updatedAt: Date.now() }).where(eq(users.id, user.id));
  }

  const existing = await db.query.memberships.findFirst({ where: eq(memberships.userId, user.id) });
  if (!existing) {
    const first = await db.query.workspaces.findFirst({ orderBy: asc(workspaces.createdAt) });
    const role = identity.email === allowed[0] ? "owner" : "member";
    if (first) {
      await db.insert(memberships).values({ workspaceId: first.id, userId: user.id, role });
    } else {
      const wsId = newId();
      await db.batch([
        db.insert(workspaces).values({ id: wsId, name: "Central de Organização" }),
        db.insert(memberships).values({ workspaceId: wsId, userId: user.id, role }),
      ]);
    }
  }
  return user;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken();
  await db.insert(sessions).values({ idHash: await sha256(token), userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export async function findSessionUser(db: Db, token: string) {
  const row = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, await sha256(token)), gt(sessions.expiresAt, Date.now())))
    .get();
  return row?.user ?? null;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.idHash, await sha256(token)));
}
