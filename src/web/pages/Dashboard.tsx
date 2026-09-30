import { useState } from "react";
import { Link } from "react-router";
import { api, qs } from "../api";
import { Icon } from "../components/Icon";
import { TaskRow } from "../components/TaskCard";
import { IdeaForm, TaskForm } from "../components/forms";
import { Empty, ErrorNote, Loading } from "../components/ui";
import { useApp, useResource } from "../state";
import { addDays, formatDay, localTime, today } from "../time";
import { taskStatusLabel, type Dashboard, type Task, type TaskStatus } from "../types";

export function DashboardPage() {
  const { me, toast } = useApp();
  const dash = useResource<Dashboard>("/api/dashboard");
  const upcoming = useResource<Task[]>(`/api/tasks${qs({ dueTo: addDays(today(), 8) })}`);
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [newIdea, setNewIdea] = useState(false);
  const reloadAll = () => {
    dash.reload();
    upcoming.reload();
  };

  const open = upcoming.data?.filter((t) => t.status !== "done").slice(0, 8) ?? [];
  const d = dash.data;
  const firstName = (me.user.name ?? me.user.email).split(/[ @]/)[0];
  const totalTasks = d ? Object.values(d.tasksByStatus).reduce((a, b) => a + (b ?? 0), 0) : 0;

  async function changeStatus(task: Task, status: TaskStatus) {
    try {
      await api.patch(`/api/tasks/${task.id}`, { status });
      if (status === "done") toast("Tarefa concluída.");
      reloadAll();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <>
      <div className="greeting">
        <div>
          <p className="muted">{formatDay(today(), { weekday: "long", day: "numeric", month: "long" })}</p>
          <h1>Olá, {firstName}</h1>
        </div>
        <div className="quick-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setNewIdea(true)}>
            <Icon name="bulb" size={16} /> Anotar ideia
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" size={16} /> Nova tarefa
          </button>
        </div>
      </div>

      <ErrorNote message={dash.error} />
      {!d && !dash.error && <Loading />}
      {d && (
        <>
          <div className="stats">
            <Link to="/tarefas?periodo=atrasadas" className={`stat${d.overdueTasks ? " stat-alert" : ""}`}>
              <span className="stat-value">{d.overdueTasks}</span>
              <span className="stat-label">Tarefas atrasadas</span>
            </Link>
            <Link to="/tarefas?periodo=hoje" className="stat">
              <span className="stat-value">{d.tasksDueToday}</span>
              <span className="stat-label">Vencem hoje</span>
            </Link>
            <Link to="/projetos" className="stat">
              <span className="stat-value">{d.activeProjects}</span>
              <span className="stat-label">Projetos ativos</span>
            </Link>
            <Link to="/ideias?status=new" className="stat">
              <span className="stat-value">{d.newIdeas}</span>
              <span className="stat-label">Ideias novas</span>
            </Link>
          </div>

          <div className="dash-grid">
            <section className="card panel">
              <header className="panel-head">
                <h2>Próximas tarefas</h2>
                <Link to="/tarefas" className="link-arrow">Todas <Icon name="arrowRight" size={14} /></Link>
              </header>
              {!upcoming.data ? (
                <Loading />
              ) : open.length === 0 ? (
                <Empty title="Nada com prazo nos próximos 7 dias." />
              ) : (
                <ul className="task-list">
                  {open.map((t) => (
                    <TaskRow key={t.id} task={t} onOpen={() => setEditing(t)} onStatus={(s) => changeStatus(t, s)} />
                  ))}
                </ul>
              )}
            </section>

            <div className="dash-side">
              <section className="card panel">
                <header className="panel-head">
                  <h2>Hoje na agenda</h2>
                  <Link to="/agenda" className="link-arrow">Agenda <Icon name="arrowRight" size={14} /></Link>
                </header>
                {d.eventsToday.length === 0 ? (
                  <p className="muted">Nenhum compromisso hoje.</p>
                ) : (
                  <ul className="agenda-mini">
                    {d.eventsToday.map((e) => (
                      <li key={e.id}>
                        <span className="event-time">{localTime(e.startAt)}</span>
                        <span>{e.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="card panel">
                <header className="panel-head">
                  <h2>Tarefas por status</h2>
                </header>
                {totalTasks === 0 ? (
                  <p className="muted">Nenhuma tarefa cadastrada.</p>
                ) : (
                  <ul className="status-bars">
                    {(Object.keys(taskStatusLabel) as TaskStatus[]).map((s) => {
                      const n = d.tasksByStatus[s] ?? 0;
                      return (
                        <li key={s}>
                          <span className="status-bar-label">{taskStatusLabel[s]}</span>
                          <span className="status-bar-track">
                            <span className={`status-bar-fill st-${s}`} style={{ width: `${(n / totalTasks) * 100}%` }} />
                          </span>
                          <span className="status-bar-value">{n}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </>
      )}
      {editing && <TaskForm task={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={reloadAll} />}
      {newIdea && <IdeaForm onClose={() => setNewIdea(false)} onSaved={reloadAll} />}
    </>
  );
}
