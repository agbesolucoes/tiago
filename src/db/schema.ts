import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Datas são inteiros em milissegundos UTC. A apresentação usa o fuso do workspace.
const now = () => integer({ mode: "number" }).notNull().default(sql`(unixepoch() * 1000)`);

const timestamps = {
  createdAt: now().$type<number>(),
  updatedAt: now().$type<number>(),
};

export const users = sqliteTable("users", {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text(),
  googleSub: text().unique(),
  ...timestamps,
});

export const sessions = sqliteTable(
  "sessions",
  {
    // Guardamos só o hash SHA-256 do token do cookie.
    idHash: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer().notNull(),
    createdAt: now(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const workspaces = sqliteTable("workspaces", {
  id: text().primaryKey(),
  name: text().notNull(),
  timezone: text().notNull().default("America/Sao_Paulo"),
  ...timestamps,
});

export const roles = ["owner", "admin", "member"] as const;
export type Role = (typeof roles)[number];

export const memberships = sqliteTable(
  "memberships",
  {
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text({ enum: roles }).notNull(),
    createdAt: now(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const priorities = ["low", "medium", "high", "urgent"] as const;
export const projectStatuses = ["active", "paused", "done", "archived"] as const;
export const taskStatuses = ["todo", "doing", "blocked", "done"] as const;
export const ideaStatuses = ["new", "evaluating", "approved", "discarded", "converted"] as const;
export const syncStatuses = ["local", "pending", "synced", "error"] as const;

export const projects = sqliteTable(
  "projects",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    status: text({ enum: projectStatuses }).notNull().default("active"),
    priority: text({ enum: priorities }).notNull().default("medium"),
    sourceIdeaId: text(),
    createdBy: text().references(() => users.id),
    ...timestamps,
  },
  (t) => [index("projects_ws_idx").on(t.workspaceId, t.status)],
);

export const events = sqliteTable(
  "events",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text().references(() => projects.id, { onDelete: "set null" }),
    title: text().notNull(),
    description: text(),
    startAt: integer().notNull(),
    endAt: integer().notNull(),
    timezone: text().notNull().default("America/Sao_Paulo"),
    allDay: integer({ mode: "boolean" }).notNull().default(false),
    remoteId: text(),
    calendarId: text(),
    syncStatus: text({ enum: syncStatuses }).notNull().default("local"),
    createdBy: text().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("events_ws_start_idx").on(t.workspaceId, t.startAt),
    uniqueIndex("events_remote_idx").on(t.workspaceId, t.calendarId, t.remoteId),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text().references(() => projects.id, { onDelete: "set null" }),
    title: text().notNull(),
    description: text(),
    status: text({ enum: taskStatuses }).notNull().default("todo"),
    priority: text({ enum: priorities }).notNull().default("medium"),
    assigneeId: text().references(() => users.id, { onDelete: "set null" }),
    dueAt: integer(),
    sourceEventId: text().references(() => events.id, { onDelete: "set null" }),
    sourceIdeaId: text(),
    createdBy: text().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("tasks_ws_status_idx").on(t.workspaceId, t.status),
    index("tasks_ws_project_idx").on(t.workspaceId, t.projectId),
    index("tasks_ws_due_idx").on(t.workspaceId, t.dueAt),
  ],
);

export const ideas = sqliteTable(
  "ideas",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    category: text(),
    status: text({ enum: ideaStatuses }).notNull().default("new"),
    origin: text(),
    convertedToKind: text({ enum: ["task", "project"] }),
    convertedToId: text(),
    createdBy: text().references(() => users.id),
    ...timestamps,
  },
  (t) => [index("ideas_ws_status_idx").on(t.workspaceId, t.status)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text().notNull(),
  },
  (t) => [uniqueIndex("tags_ws_name_idx").on(t.workspaceId, t.name)],
);

export const ideaTags = sqliteTable(
  "idea_tags",
  {
    ideaId: text()
      .notNull()
      .references(() => ideas.id, { onDelete: "cascade" }),
    tagId: text()
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.ideaId, t.tagId] })],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text().primaryKey(),
    workspaceId: text().notNull(),
    userId: text(),
    entity: text().notNull(),
    entityId: text().notNull(),
    action: text({ enum: ["create", "update", "delete", "convert"] }).notNull(),
    before: text({ mode: "json" }),
    after: text({ mode: "json" }),
    createdAt: now(),
  },
  (t) => [index("audit_ws_entity_idx").on(t.workspaceId, t.entity, t.entityId)],
);

// ---------- Integrações (Google) ----------

export const integrationStatuses = ["active", "revoked", "error"] as const;

/** Conta Google autorizada para Calendar/Drive. Tokens sempre cifrados (AES-GCM). */
export const integrationAccounts = sqliteTable(
  "integration_accounts",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text({ enum: ["google"] }).notNull(),
    externalSub: text().notNull(),
    email: text().notNull(),
    scopes: text().notNull(),
    refreshTokenEnc: text().notNull(),
    accessTokenEnc: text(),
    accessTokenExpiresAt: integer(),
    /** Agenda que recebe os compromissos criados na Central. */
    defaultCalendarId: text(),
    /** Pastas da Central no Drive: { root, project, event, idea, general } → id da pasta. */
    driveFolders: text({ mode: "json" }).$type<Record<string, string>>(),
    status: text({ enum: integrationStatuses }).notNull().default("active"),
    lastError: text(),
    lastSyncAt: integer(),
    ...timestamps,
  },
  (t) => [uniqueIndex("integration_ws_provider_idx").on(t.workspaceId, t.provider)],
);

export const calendars = sqliteTable(
  "calendars",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: text()
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    googleCalendarId: text().notNull(),
    summary: text().notNull(),
    primary: integer({ mode: "boolean" }).notNull().default(false),
    writable: integer({ mode: "boolean" }).notNull().default(false),
    selected: integer({ mode: "boolean" }).notNull().default(false),
    syncToken: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex("calendars_account_gid_idx").on(t.accountId, t.googleCalendarId)],
);

export const syncJobStatuses = ["pending", "done", "failed"] as const;

/** Fila de envio ao Google, com idempotência e repetição com backoff. */
export const syncJobs = sqliteTable(
  "sync_jobs",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text({ enum: ["event.upsert", "event.delete"] }).notNull(),
    eventId: text().notNull(),
    /** Para exclusões o evento local já não existe: guardamos onde ele está no Google. */
    payload: text({ mode: "json" }).$type<{ calendarId?: string; remoteId?: string }>(),
    idempotencyKey: text().notNull().unique(),
    status: text({ enum: syncJobStatuses }).notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: integer().notNull(),
    error: text(),
    ...timestamps,
  },
  (t) => [index("sync_jobs_due_idx").on(t.status, t.nextAttemptAt)],
);

// ---------- Drive e reuniões ----------

export const attachmentParents = ["project", "task", "event", "idea", "general"] as const;

/** Arquivo no Drive vinculado a um registro. A Central nunca altera o compartilhamento (ACL). */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text().primaryKey(),
    workspaceId: text()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentKind: text({ enum: attachmentParents }).notNull(),
    parentId: text(),
    driveFileId: text().notNull(),
    name: text().notNull(),
    mimeType: text(),
    size: integer(),
    webViewLink: text(),
    /** uploaded: enviado pela Central; linked: escolhido no Picker. */
    origin: text({ enum: ["uploaded", "linked"] }).notNull(),
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("attachments_parent_idx").on(t.workspaceId, t.parentKind, t.parentId),
    uniqueIndex("attachments_file_parent_idx").on(t.workspaceId, t.driveFileId, t.parentKind, t.parentId),
  ],
);

export interface Decision {
  id: string;
  text: string;
  taskId?: string | null;
}

/** Registro de reunião ligado a um compromisso: pauta, resumo e decisões. */
export const meetingNotes = sqliteTable("meeting_notes", {
  eventId: text()
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  workspaceId: text()
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  agenda: text(),
  summary: text(),
  decisions: text({ mode: "json" }).$type<Decision[]>().notNull().default(sql`'[]'`),
  updatedBy: text().references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});
