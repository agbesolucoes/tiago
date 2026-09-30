import { useState } from "react";
import { useSearchParams } from "react-router";
import { api, qs } from "../api";
import { Icon } from "../components/Icon";
import { KanbanCard, TaskRow } from "../components/TaskCard";
import { TaskForm } from "../components/forms";
import { Empty, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useApp, useResource } from "../state";
import { addDays, today } from "../time";
import { priorityLabel, taskStatusLabel, type Task, type TaskStatus } from "../types";

const STATUSES = Object.keys(taskStatusLabel) as TaskStatus[];

export function TasksPage() {
  const { projects, members, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const view = params.get("ver") === "kanban" ? "kanban" : "lista";
  const filters = {
    q: params.get("q"),
    projectId: params.get("projeto"),
    priority: params.get("prioridade"),
    status: view === "lista" ? params.get("status") : null,
    assigneeId: params.get("responsavel"),
    ...periodRange(params.get("periodo")),
  };
  const { data, error, reload, setData } = useResource<Task[]>(`/api/tasks${qs(filters)}`);
  const tasks = params.get("periodo") === "atrasadas" ? (data?.filter((t) => t.status !== "done") ?? null) : data;
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  async function changeStatus(task: Task, status: TaskStatus) {
    if (task.status === status) return;
    setData((list) => list?.map((t) => (t.id === task.id ? { ...t, status } : t)) ?? null);
    try {
      await api.patch(`/api/tasks/${task.id}`, { status });
      if (status === "done") toast("Tarefa concluída.");
    } catch (e) {
      toast((e as Error).message, "error");
      reload();
    }
  }

  const activeFilters = ["q", "projeto", "prioridade", "status", "responsavel", "periodo"].filter((k) => params.get(k)).length;

  return (
    <>
      <PageHeader title="Tarefas">
        <div className="segmented small" role="tablist" aria-label="Visualização">
          <button type="button" role="tab" aria-selected={view === "lista"} className={view === "lista" ? "active" : ""} onClick={() => set("ver", "")}>
            <Icon name="list" size={16} /> Lista
          </button>
          <button type="button" role="tab" aria-selected={view === "kanban"} className={view === "kanban" ? "active" : ""} onClick={() => set("ver", "kanban")}>
            <Icon name="columns" size={16} /> Kanban
          </button>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          <Icon name="plus" size={16} /> Nova tarefa
        </button>
      </PageHeader>

      <div className="filters">
        <input type="search" placeholder="Buscar tarefas" value={params.get("q") ?? ""} onChange={(e) => set("q", e.target.value)} aria-label="Buscar tarefas" />
        <select value={params.get("projeto") ?? ""} onChange={(e) => set("projeto", e.target.value)} aria-label="Projeto">
          <option value="">Todos os projetos</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
        <select value={params.get("prioridade") ?? ""} onChange={(e) => set("prioridade", e.target.value)} aria-label="Prioridade">
          <option value="">Qualquer prioridade</option>
          {Object.entries(priorityLabel).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        {view === "lista" && (
          <select value={params.get("status") ?? ""} onChange={(e) => set("status", e.target.value)} aria-label="Status">
            <option value="">Qualquer status</option>
            {Object.entries(taskStatusLabel).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        )}
        {members.length > 1 && (
          <select value={params.get("responsavel") ?? ""} onChange={(e) => set("responsavel", e.target.value)} aria-label="Responsável">
            <option value="">Qualquer responsável</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name ?? m.email}</option>
            ))}
          </select>
        )}
        <select value={params.get("periodo") ?? ""} onChange={(e) => set("periodo", e.target.value)} aria-label="Prazo">
          <option value="">Qualquer prazo</option>
          <option value="hoje">Vence hoje</option>
          <option value="semana">Próximos 7 dias</option>
          <option value="atrasadas">Atrasadas</option>
        </select>
        {activeFilters > 0 && (
          <button type="button" className="btn btn-ghost small" onClick={() => setParams(view === "kanban" ? { ver: "kanban" } : {}, { replace: true })}>
            Limpar filtros
          </button>
        )}
      </div>

      <ErrorNote message={error} />
      {!tasks && !error && <Loading />}
      {tasks && view === "lista" && (
        tasks.length === 0 ? (
          <Empty title={activeFilters ? "Nenhuma tarefa com esses filtros." : "Nenhuma tarefa ainda."}>
            {!activeFilters && <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>Criar a primeira tarefa</button>}
          </Empty>
        ) : (
          <ul className="task-list card">
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} onOpen={() => setEditing(t)} onStatus={(s) => changeStatus(t, s)} />
            ))}
          </ul>
        )
      )}
      {tasks && view === "kanban" && (
        <div className="kanban">
          {STATUSES.map((status) => {
            const column = tasks.filter((t) => t.status === status);
            return (
              <section
                key={status}
                className={`kanban-col${dragOver === status ? " drag-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(status);
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const t = tasks.find((x) => x.id === e.dataTransfer.getData("text/task-id"));
                  if (t) changeStatus(t, status);
                }}
              >
                <header className="kanban-head">
                  <span className={`status-dot st-${status}`}>{taskStatusLabel[status]}</span>
                  <span className="count">{column.length}</span>
                </header>
                <div className="kanban-cards">
                  {column.map((t) => (
                    <KanbanCard key={t.id} task={t} onOpen={() => setEditing(t)} onStatus={(s) => changeStatus(t, s)} />
                  ))}
                  {column.length === 0 && <p className="kanban-empty">Arraste tarefas para cá</p>}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {editing && (
        <TaskForm
          task={editing === "new" ? undefined : editing}
          defaults={editing === "new" ? { projectId: params.get("projeto") } : undefined}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </>
  );
}

function periodRange(period: string | null): { dueFrom?: string; dueTo?: string } {
  const d = today();
  if (period === "hoje") return { dueFrom: d, dueTo: addDays(d, 1) };
  if (period === "semana") return { dueFrom: d, dueTo: addDays(d, 8) };
  if (period === "atrasadas") return { dueTo: new Date().toISOString() };
  return {};
}
