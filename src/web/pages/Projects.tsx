import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Icon } from "../components/Icon";
import { ProjectForm } from "../components/forms";
import { Badge, Empty, ErrorNote, Loading, PageHeader, PriorityBadge } from "../components/ui";
import { useApp, useResource } from "../state";
import { projectStatusLabel, type Project, type ProjectStatus, type Task } from "../types";

const tone: Record<ProjectStatus, "ok" | "neutral" | "accent" | "warn"> = { active: "accent", paused: "warn", done: "ok", archived: "neutral" };

export function ProjectsPage() {
  const { projects, reloadProjects } = useApp();
  const { data: tasks, error } = useResource<Task[]>("/api/tasks");
  const [editing, setEditing] = useState<Project | "new" | null>(null);
  const [status, setStatus] = useState<ProjectStatus | "">("active");
  useEffect(() => {
    reloadProjects().catch(() => {});
  }, [reloadProjects]);
  const visible = projects.filter((p) => !status || p.status === status);

  return (
    <>
      <PageHeader title="Projetos">
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          <Icon name="plus" size={16} /> Novo projeto
        </button>
      </PageHeader>
      <div className="chips-row" role="tablist" aria-label="Status do projeto">
        {(["active", "paused", "done", "archived", ""] as const).map((s) => (
          <button key={s || "all"} type="button" role="tab" aria-selected={status === s} className={`filter-chip${status === s ? " active" : ""}`} onClick={() => setStatus(s)}>
            {s ? projectStatusLabel[s] : "Todos"}
            <span className="count">{s ? projects.filter((p) => p.status === s).length : projects.length}</span>
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      {!tasks && !error && <Loading />}
      {tasks &&
        (visible.length === 0 ? (
          <Empty title={projects.length ? "Nenhum projeto com esse status." : "Nenhum projeto ainda."}>
            {!projects.length && <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>Criar o primeiro projeto</button>}
          </Empty>
        ) : (
          <div className="project-grid">
            {visible.map((p) => {
              const own = tasks.filter((t) => t.projectId === p.id);
              const done = own.filter((t) => t.status === "done").length;
              const pct = own.length ? Math.round((done / own.length) * 100) : 0;
              return (
                <article key={p.id} className="card project-card">
                  <button type="button" className="project-open" onClick={() => setEditing(p)}>
                    <div className="project-top">
                      <h3>{p.title}</h3>
                      <Badge tone={tone[p.status]}>{projectStatusLabel[p.status]}</Badge>
                    </div>
                    {p.description && <p className="muted clamp-2">{p.description}</p>}
                  </button>
                  <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Progresso de ${p.title}`}>
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <div className="project-foot">
                    <span className="muted small">
                      {own.length ? `${done} de ${own.length} tarefas concluídas` : "Sem tarefas"}
                    </span>
                    <PriorityBadge priority={p.priority} />
                  </div>
                  <Link className="link-arrow" to={`/tarefas?projeto=${p.id}`}>
                    Ver tarefas <Icon name="arrowRight" size={14} />
                  </Link>
                </article>
              );
            })}
          </div>
        ))}
      {editing && <ProjectForm project={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => {}} />}
    </>
  );
}
