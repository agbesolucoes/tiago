export type Priority = "low" | "medium" | "high" | "urgent";
export type TaskStatus = "todo" | "doing" | "blocked" | "done";
export type ProjectStatus = "active" | "paused" | "done" | "archived";
export type IdeaStatus = "new" | "evaluating" | "approved" | "discarded" | "converted";
export type Role = "owner" | "admin" | "member";

export interface Me {
  user: { id: string; email: string; name: string | null };
  workspace: { id: string; role: Role; timezone: string };
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

interface Base {
  id: string;
  title: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project extends Base {
  status: ProjectStatus;
  priority: Priority;
  sourceIdeaId: string | null;
}

export interface Task extends Base {
  status: TaskStatus;
  priority: Priority;
  projectId: string | null;
  assigneeId: string | null;
  dueAt: string | null;
  sourceEventId: string | null;
  sourceIdeaId: string | null;
  /** Vêm só na listagem de tarefas. */
  checklistTotal?: number;
  checklistDone?: number;
  commentCount?: number;
}

export interface Idea extends Base {
  category: string | null;
  status: IdeaStatus;
  origin: string | null;
  convertedToKind: "task" | "project" | null;
  convertedToId: string | null;
  tags: string[];
}

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface Repeat {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  byDay?: Weekday[];
  until?: string | null;
  count?: number | null;
}

export interface CalendarEvent extends Base {
  startAt: string;
  endAt: string;
  allDay: boolean;
  projectId: string | null;
  syncStatus: "local" | "pending" | "synced" | "error";
  /** Faz parte de uma série (ocorrência da série ou ocorrência alterada). */
  recurring: boolean;
  /** Série de origem; numa ocorrência da série é o próprio id. */
  seriesId: string | null;
  occurrenceStart?: string | null;
  seriesStartAt?: string | null;
  seriesEndAt?: string | null;
  recurrence: string | null;
  repeat: Repeat | null;
  customRepeat: boolean;
  reminderMinutes: number | null;
}

export interface Conflict {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
}

export interface Dashboard {
  tasksByStatus: Partial<Record<TaskStatus, number>>;
  overdueTasks: number;
  tasksDueToday: number;
  eventsToday: CalendarEvent[];
  newIdeas: number;
  activeProjects: number;
}

export const priorityLabel: Record<Priority, string> = { low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" };
export const taskStatusLabel: Record<TaskStatus, string> = { todo: "A fazer", doing: "Fazendo", blocked: "Bloqueada", done: "Concluída" };
export const projectStatusLabel: Record<ProjectStatus, string> = { active: "Ativo", paused: "Pausado", done: "Concluído", archived: "Arquivado" };
export const ideaStatusLabel: Record<IdeaStatus, string> = {
  new: "Nova",
  evaluating: "Em avaliação",
  approved: "Aprovada",
  discarded: "Descartada",
  converted: "Convertida",
};
export const roleLabel: Record<Role, string> = { owner: "Dono", admin: "Administrador", member: "Membro" };

export interface MarketStudy {
  id: string;
  address: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
  verdict: string | null;
  score: number | null;
  coverage: number | null;
  analyzedAt: string;
  projectId: string | null;
  hasState: boolean;
  createdAt: string;
}
