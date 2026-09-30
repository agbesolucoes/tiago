import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, qs } from "../api";
import { TaskRow } from "../components/TaskCard";
import { TaskForm } from "../components/forms";
import { Badge, Empty, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useApp, useResource } from "../state";
import { formatDay, localDate, localTime } from "../time";
import { ideaStatusLabel, projectStatusLabel, type CalendarEvent, type Idea, type Project, type Task, type TaskStatus } from "../types";

interface Results {
  tasks: Task[];
  projects: Project[];
  ideas: Idea[];
  events: CalendarEvent[];
}

export function SearchPage() {
  const { toast } = useApp();
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const { data, error, reload } = useResource<Results>(q ? `/api/search${qs({ q })}` : null);
  const [editing, setEditing] = useState<Task | null>(null);
  const total = data ? data.tasks.length + data.projects.length + data.ideas.length + data.events.length : 0;

  async function changeStatus(task: Task, status: TaskStatus) {
    try {
      await api.patch(`/api/tasks/${task.id}`, { status });
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <>
      <PageHeader title={q ? `Busca: “${q}”` : "Busca"} />
      {!q && <Empty title="Digite algo na busca do topo." />}
      <ErrorNote message={error} />
      {q && !data && !error && <Loading />}
      {data && total === 0 && <Empty title="Nada encontrado." />}
      {data && data.tasks.length > 0 && (
        <section className="search-section">
          <h2>Tarefas</h2>
          <ul className="task-list card">
            {data.tasks.map((t) => (
              <TaskRow key={t.id} task={t} onOpen={() => setEditing(t)} onStatus={(s) => changeStatus(t, s)} />
            ))}
          </ul>
        </section>
      )}
      {data && data.projects.length > 0 && (
        <section className="search-section">
          <h2>Projetos</h2>
          <ul className="simple-list card">
            {data.projects.map((p) => (
              <li key={p.id}>
                <Link to={`/tarefas?projeto=${p.id}`}>{p.title}</Link>
                <Badge>{projectStatusLabel[p.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data && data.ideas.length > 0 && (
        <section className="search-section">
          <h2>Ideias</h2>
          <ul className="simple-list card">
            {data.ideas.map((i) => (
              <li key={i.id}>
                <Link to={`/ideias?q=${encodeURIComponent(i.title)}`}>{i.title}</Link>
                <Badge>{ideaStatusLabel[i.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data && data.events.length > 0 && (
        <section className="search-section">
          <h2>Compromissos</h2>
          <ul className="simple-list card">
            {data.events.map((e) => (
              <li key={e.id}>
                <Link to={`/agenda?semana=${localDate(e.startAt)}`}>{e.title}</Link>
                <span className="muted small">
                  {formatDay(localDate(e.startAt))} {localTime(e.startAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {editing && <TaskForm task={editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}
