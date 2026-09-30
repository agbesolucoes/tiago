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
