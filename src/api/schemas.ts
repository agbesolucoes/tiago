import { z } from "zod";
import { ideaStatuses, priorities, projectStatuses, taskStatuses } from "../db/schema";

const title = z.string().trim().min(1, "título obrigatório").max(200);
const description = z.string().max(10_000).nullable().optional();
const id = z.string().min(1).max(64);
/** Data ISO com offset ou hora local ("2026-10-01T09:00"), interpretada no fuso do workspace. */
const dateTime = z.string().min(10).max(40);

export const projectCreate = z.strictObject({
  title,
  description,
  status: z.enum(projectStatuses).optional(),
  priority: z.enum(priorities).optional(),
});
export const projectUpdate = projectCreate.partial();

export const taskCreate = z.strictObject({
  title,
  description,
  status: z.enum(taskStatuses).optional(),
  priority: z.enum(priorities).optional(),
  projectId: id.nullable().optional(),
  assigneeId: id.nullable().optional(),
  dueAt: dateTime.nullable().optional(),
  sourceEventId: id.nullable().optional(),
});
export const taskUpdate = taskCreate.partial();

export const ideaCreate = z.strictObject({
  title,
  description,
  category: z.string().trim().max(60).nullable().optional(),
  status: z.enum(ideaStatuses).exclude(["converted"]).optional(),
  origin: z.string().trim().max(200).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
export const ideaUpdate = ideaCreate.partial();

export const ideaConvert = z.strictObject({
  to: z.enum(["task", "project"]),
  projectId: id.nullable().optional(),
  priority: z.enum(priorities).optional(),
});

export const eventCreate = z.strictObject({
  title,
  description,
  startAt: dateTime,
  endAt: dateTime,
  allDay: z.boolean().optional(),
  projectId: id.nullable().optional(),
});
export const eventUpdate = eventCreate.partial();
