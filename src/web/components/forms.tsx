import { useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "../api";
import { useApp } from "../state";
import { addDays, localDate, localTime, today } from "../time";
import {
  ideaStatusLabel,
  priorityLabel,
  projectStatusLabel,
  taskStatusLabel,
  type CalendarEvent,
  type Conflict,
  type Idea,
  type IdeaStatus,
  type Priority,
  type Project,
  type ProjectStatus,
  type Task,
  type TaskStatus,
} from "../types";
import { Attachments } from "./Attachments";
import { MeetingNotes } from "./MeetingNotes";
import { ErrorNote, Field, Modal } from "./ui";

type Issues = Record<string, string>;

/** Estado comum de formulário: salvar mantém os campos se a API falhar. */
function useSubmit() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issues>({});
  async function run(fn: () => Promise<void>) {
    setSaving(true);
    setError(null);
    setIssues({});
    try {
      await fn();
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
      setIssues(Object.fromEntries((err.issues ?? []).map((i) => [i.path, i.message])));
    } finally {
      setSaving(false);
    }
  }
  return { saving, error, issues, run, setError };
}

function Footer({ saving, onClose, onDelete, submitLabel = "Salvar", extra }: { saving: boolean; onClose: () => void; onDelete?: () => void; submitLabel?: string; extra?: ReactNode }) {
  return (
    <>
      {onDelete && (
        <button type="button" className="btn btn-danger-ghost" onClick={onDelete} disabled={saving}>
          Excluir
        </button>
      )}
      {extra}
      <span className="spacer" />
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
        Cancelar
      </button>
      <button type="submit" form="entity-form" className="btn btn-primary" disabled={saving}>
        {saving ? "Salvando…" : submitLabel}
      </button>
    </>
  );
}

function useConfirmDelete(path: string | null, label: string, onDone: () => void) {
  const { toast } = useApp();
  return path
    ? async () => {
        if (!confirm(`Excluir ${label}? Esta ação não pode ser desfeita.`)) return;
        try {
          await api.del(path);
          toast(`${label[0].toUpperCase()}${label.slice(1)} excluída.`);
          onDone();
        } catch (e) {
          toast((e as Error).message, "error");
        }
      }
    : undefined;
}

// ---------- Tarefa ----------

export function TaskForm({ task, defaults, onClose, onSaved }: { task?: Task; defaults?: Partial<Task>; onClose: () => void; onSaved: (t: Task | null) => void }) {
  const { projects, members, canDelete, toast } = useApp();
  const init = { ...defaults, ...task };
  const [title, setTitle] = useState(init.title ?? "");
  const [description, setDescription] = useState(init.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(init.status ?? "todo");
  const [priority, setPriority] = useState<Priority>(init.priority ?? "medium");
  const [projectId, setProjectId] = useState(init.projectId ?? "");
  const [assigneeId, setAssigneeId] = useState(init.assigneeId ?? "");
  const [dueDate, setDueDate] = useState(init.dueAt ? localDate(init.dueAt) : "");
  const [dueTime, setDueTime] = useState(init.dueAt && localTime(init.dueAt) !== "00:00" ? localTime(init.dueAt) : "");
  const f = useSubmit();
  const onDelete = useConfirmDelete(task && canDelete ? `/api/tasks/${task.id}` : null, "tarefa", () => {
    onSaved(null);
    onClose();
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    f.run(async () => {
      const body = {
        title,
        description: description || null,
        status,
        priority,
        projectId: projectId || null,
        assigneeId: assigneeId || null,
        dueAt: dueDate ? `${dueDate}T${dueTime || "00:00"}` : null,
      };
      const saved = task ? await api.patch<Task>(`/api/tasks/${task.id}`, body) : await api.post<Task>("/api/tasks", body);
      toast(task ? "Tarefa atualizada." : "Tarefa criada.");
      onSaved(saved);
      onClose();
    });
  };

  return (
    <Modal title={task ? "Editar tarefa" : "Nova tarefa"} onClose={onClose} footer={<Footer saving={f.saving} onClose={onClose} onDelete={onDelete} />}>
      <form id="entity-form" onSubmit={submit} className="form">
        <ErrorNote message={f.error} />
        <Field label="Título" error={f.issues.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Descrição">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <div className="grid-2">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {Object.entries(taskStatusLabel).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
          <Field label="Prioridade">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {Object.entries(priorityLabel).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
          <Field label="Projeto" error={f.issues.projectId}>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Sem projeto</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Responsável" error={f.issues.assigneeId}>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Ninguém</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name ?? m.email}</option>
              ))}
            </select>
          </Field>
          <Field label="Prazo" error={f.issues.dueAt}>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Horário" hint="Opcional">
            <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} disabled={!dueDate} />
          </Field>
        </div>
        {task?.sourceIdeaId && <p className="muted small">Criada a partir de uma ideia.</p>}
        {task?.sourceEventId && <p className="muted small">Criada a partir de uma decisão de reunião.</p>}
        {task && <Attachments kind="task" parentId={task.id} />}
      </form>
    </Modal>
  );
}

// ---------- Projeto ----------

export function ProjectForm({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved: () => void }) {
  const { canDelete, toast, reloadProjects } = useApp();
  const [title, setTitle] = useState(project?.title ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "active");
  const [priority, setPriority] = useState<Priority>(project?.priority ?? "medium");
  const f = useSubmit();
  const done = async () => {
    await reloadProjects();
    onSaved();
    onClose();
  };
  const onDelete = useConfirmDelete(project && canDelete ? `/api/projects/${project.id}` : null, "o projeto", done);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    f.run(async () => {
      const body = { title, description: description || null, status, priority };
      if (project) await api.patch(`/api/projects/${project.id}`, body);
      else await api.post("/api/projects", body);
      toast(project ? "Projeto atualizado." : "Projeto criado.");
      await done();
    });
  };

  return (
    <Modal title={project ? "Editar projeto" : "Novo projeto"} onClose={onClose} footer={<Footer saving={f.saving} onClose={onClose} onDelete={onDelete} />}>
      <form id="entity-form" onSubmit={submit} className="form">
        <ErrorNote message={f.error} />
        <Field label="Nome" error={f.issues.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Descrição">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <div className="grid-2">
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {Object.entries(projectStatusLabel).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
          <Field label="Prioridade">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {Object.entries(priorityLabel).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
        </div>
        {project && <Attachments kind="project" parentId={project.id} />}
      </form>
    </Modal>
  );
}

// ---------- Ideia ----------

export function IdeaForm({ idea, onClose, onSaved }: { idea?: Idea; onClose: () => void; onSaved: () => void }) {
  const { canDelete, toast } = useApp();
  const [title, setTitle] = useState(idea?.title ?? "");
  const [description, setDescription] = useState(idea?.description ?? "");
  const [category, setCategory] = useState(idea?.category ?? "");
  const [origin, setOrigin] = useState(idea?.origin ?? "");
  const [status, setStatus] = useState<IdeaStatus>(idea?.status ?? "new");
  const [tags, setTags] = useState((idea?.tags ?? []).join(", "));
  const converted = idea?.status === "converted";
  const f = useSubmit();
  const onDelete = useConfirmDelete(idea && canDelete ? `/api/ideas/${idea.id}` : null, "a ideia", () => {
    onSaved();
    onClose();
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    f.run(async () => {
      const body = {
        title,
        description: description || null,
        category: category || null,
        origin: origin || null,
        ...(!converted && { status: status as Exclude<IdeaStatus, "converted"> }),
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      };
      if (idea) await api.patch(`/api/ideas/${idea.id}`, body);
      else await api.post("/api/ideas", body);
      toast(idea ? "Ideia atualizada." : "Ideia registrada.");
      onSaved();
      onClose();
    });
  };

  return (
    <Modal title={idea ? "Editar ideia" : "Nova ideia"} onClose={onClose} footer={<Footer saving={f.saving} onClose={onClose} onDelete={onDelete} />}>
      <form id="entity-form" onSubmit={submit} className="form">
        <ErrorNote message={f.error} />
        <Field label="Ideia" error={f.issues.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Detalhes">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </Field>
        <div className="grid-2">
          <Field label="Categoria">
            <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} placeholder="Ex.: casa, trabalho" />
          </Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value as IdeaStatus)} disabled={converted}>
              {Object.entries(ideaStatusLabel)
                .filter(([v]) => converted || v !== "converted")
                .map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
            </select>
          </Field>
          <Field label="Origem" hint="De onde veio a ideia">
            <input value={origin} onChange={(e) => setOrigin(e.target.value)} maxLength={200} placeholder="Ex.: reunião de segunda" />
          </Field>
          <Field label="Etiquetas" hint="Separe por vírgula" error={f.issues.tags}>
            <input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        {idea && <Attachments kind="idea" parentId={idea.id} />}
      </form>
    </Modal>
  );
}

export function ConvertIdea({ idea, onClose, onDone }: { idea: Idea; onClose: () => void; onDone: (kind: "task" | "project", id: string) => void }) {
  const { projects, toast, reloadProjects } = useApp();
  const [to, setTo] = useState<"task" | "project">("task");
  const [projectId, setProjectId] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const f = useSubmit();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    f.run(async () => {
      const res = await api.post<{ kind: "task" | "project"; record: { id: string } }>(`/api/ideas/${idea.id}/convert`, {
        to,
        priority,
        ...(to === "task" && { projectId: projectId || null }),
      });
      if (res.kind === "project") await reloadProjects();
      toast(res.kind === "task" ? "Ideia virou tarefa." : "Ideia virou projeto.");
      onDone(res.kind, res.record.id);
    });
  };
  return (
    <Modal title="Converter ideia" onClose={onClose} footer={<Footer saving={f.saving} onClose={onClose} submitLabel="Converter" />}>
      <form id="entity-form" onSubmit={submit} className="form">
        <ErrorNote message={f.error} />
        <p className="convert-title">“{idea.title}”</p>
        <div className="segmented" role="radiogroup" aria-label="Converter em">
          {(["task", "project"] as const).map((k) => (
            <button type="button" key={k} role="radio" aria-checked={to === k} className={to === k ? "active" : ""} onClick={() => setTo(k)}>
              {k === "task" ? "Tarefa" : "Projeto"}
            </button>
          ))}
        </div>
        <div className="grid-2">
          {to === "task" && (
            <Field label="Projeto">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Sem projeto</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Prioridade">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {Object.entries(priorityLabel).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </Field>
        </div>
        <p className="muted small">O título e os detalhes são copiados, e a ideia fica marcada como convertida, com o vínculo guardado.</p>
      </form>
    </Modal>
  );
}

// ---------- Compromisso ----------

export function EventForm({ event, date, onClose, onSaved }: { event?: CalendarEvent; date?: string; onClose: () => void; onSaved: (conflicts: Conflict[]) => void }) {
  const { projects, canDelete, toast } = useApp();
  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [day, setDay] = useState(event ? localDate(event.startAt) : (date ?? today()));
  const [start, setStart] = useState(event ? localTime(event.startAt) : "09:00");
  const [endDay, setEndDay] = useState(event ? localDate(event.endAt) : (date ?? today()));
  const [end, setEnd] = useState(event ? localTime(event.endAt) : "10:00");
  const [projectId, setProjectId] = useState(event?.projectId ?? "");
  const f = useSubmit();
  const [notesOpen, setNotesOpen] = useState(false);
  const onDelete = useConfirmDelete(event && canDelete ? `/api/events/${event.id}` : null, "o compromisso", () => {
    onSaved([]);
    onClose();
  });

  // Ao mudar o início, o término acompanha para não ficar antes dele.
  const changeDay = (v: string) => {
    if (endDay < v || endDay === day) setEndDay(v);
    setDay(v);
  };
  const changeStart = (v: string) => {
    if (endDay === day && end <= v) {
      const [h, m] = v.split(":").map(Number);
      const next = h + 1;
      if (next > 23) {
        setEndDay(addDays(day, 1));
        setEnd(`${String(next - 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
      } else setEnd(`${String(next).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
    setStart(v);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    f.run(async () => {
      const body = { title, description: description || null, startAt: `${day}T${start}`, endAt: `${endDay}T${end}`, projectId: projectId || null };
      const saved = event
        ? await api.patch<CalendarEvent & { conflicts: Conflict[] }>(`/api/events/${event.id}`, body)
        : await api.post<CalendarEvent & { conflicts: Conflict[] }>("/api/events", body);
      toast(event ? "Compromisso atualizado." : "Compromisso criado.");
      onSaved(saved.conflicts);
      onClose();
    });
  };

  if (notesOpen && event) return <MeetingNotes event={event} onClose={() => setNotesOpen(false)} />;

  return (
    <Modal
      title={event ? "Editar compromisso" : "Novo compromisso"}
      onClose={onClose}
      footer={
        <Footer
          saving={f.saving}
          onClose={onClose}
          onDelete={onDelete}
          extra={
            event && (
              <button type="button" className="btn btn-secondary" onClick={() => setNotesOpen(true)} disabled={f.saving}>
                Registro da reunião
              </button>
            )
          }
        />
      }
    >
      <form id="entity-form" onSubmit={submit} className="form">
        <ErrorNote message={f.error} />
        <Field label="Título" error={f.issues.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </Field>
        <div className="grid-2">
          <Field label="Início" error={f.issues.startAt}>
            <input type="date" value={day} onChange={(e) => changeDay(e.target.value)} required />
          </Field>
          <Field label="Hora de início">
            <input type="time" value={start} onChange={(e) => changeStart(e.target.value)} required />
          </Field>
          <Field label="Término" error={f.issues.endAt}>
            <input type="date" value={endDay} min={day} onChange={(e) => setEndDay(e.target.value)} required />
          </Field>
          <Field label="Hora de término">
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </Field>
        </div>
        <Field label="Projeto">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Sem projeto</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </Field>
        <Field label="Descrição">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <p className="muted small">
          Horários no fuso {useApp().me.workspace.timezone}.
          {event?.syncStatus === "synced" && " Sincronizado com o Google Agenda."}
          {event?.syncStatus === "pending" && " Aguardando envio ao Google Agenda."}
          {event?.syncStatus === "error" && " O último envio ao Google falhou; salvar de novo tenta outra vez."}
        </p>
        {event && <Attachments kind="event" parentId={event.id} />}
      </form>
    </Modal>
  );
}
