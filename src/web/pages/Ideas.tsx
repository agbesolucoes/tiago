import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { qs } from "../api";
import { Icon } from "../components/Icon";
import { ConvertIdea, IdeaForm } from "../components/forms";
import { Badge, Empty, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useResource } from "../state";
import { formatDue } from "../time";
import { ideaStatusLabel, type Idea, type IdeaStatus } from "../types";

const tone: Record<IdeaStatus, "accent" | "warn" | "ok" | "neutral" | "danger"> = {
  new: "accent",
  evaluating: "warn",
  approved: "ok",
  discarded: "neutral",
  converted: "neutral",
};

export function IdeasPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";
  const list = useResource<Idea[]>(`/api/ideas${qs({ status, q })}`);
  const { data: all, reload: reloadAll } = useResource<Idea[]>("/api/ideas");
  const { data: ideas, error } = list;
  const reload = () => {
    list.reload();
    reloadAll();
  };
  const [editing, setEditing] = useState<Idea | "new" | null>(null);
  const [converting, setConverting] = useState<Idea | null>(null);

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title="Ideias">
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          <Icon name="plus" size={16} /> Nova ideia
        </button>
      </PageHeader>
      <div className="filters">
        <input type="search" placeholder="Buscar ideias" value={q} onChange={(e) => set("q", e.target.value)} aria-label="Buscar ideias" />
      </div>
      <div className="chips-row" role="tablist" aria-label="Status da ideia">
        {(["", "new", "evaluating", "approved", "converted", "discarded"] as const).map((s) => (
          <button key={s || "all"} type="button" role="tab" aria-selected={status === s} className={`filter-chip${status === s ? " active" : ""}`} onClick={() => set("status", s)}>
            {s ? ideaStatusLabel[s] : "Todas"}
            {all && <span className="count">{s ? all.filter((i) => i.status === s).length : all.length}</span>}
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      {!ideas && !error && <Loading />}
      {ideas &&
        (ideas.length === 0 ? (
          <Empty title={status || q ? "Nenhuma ideia com esses filtros." : "Nenhuma ideia ainda."}>
            {!status && !q && <p>Anote aqui o que surgir. Depois dá para transformar em tarefa ou projeto.</p>}
          </Empty>
        ) : (
          <div className="idea-grid">
            {ideas.map((idea) => (
              <article key={idea.id} className={`card idea-card${idea.status === "converted" ? " is-converted" : ""}`}>
                <button type="button" className="idea-open" onClick={() => setEditing(idea)}>
                  <div className="idea-top">
                    <Badge tone={tone[idea.status]}>{ideaStatusLabel[idea.status]}</Badge>
                    {idea.category && <span className="chip">{idea.category}</span>}
                  </div>
                  <h3>{idea.title}</h3>
                  {idea.description && <p className="muted clamp-3">{idea.description}</p>}
                </button>
                {idea.tags.length > 0 && (
                  <div className="tags">
                    {idea.tags.map((t) => (
                      <span key={t} className="tag">#{t}</span>
                    ))}
                  </div>
                )}
                <div className="idea-foot">
                  <span className="muted small">
                    {idea.origin ? `${idea.origin} · ` : ""}
                    {formatDue(idea.createdAt)}
                  </span>
                  {idea.status === "converted" ? (
                    <button
                      type="button"
                      className="btn btn-ghost small"
                      onClick={() => navigate(idea.convertedToKind === "project" ? "/projetos" : `/tarefas?q=${encodeURIComponent(idea.title)}`)}
                    >
                      Ver {idea.convertedToKind === "project" ? "projeto" : "tarefa"} <Icon name="arrowRight" size={14} />
                    </button>
                  ) : (
                    idea.status !== "discarded" && (
                      <button type="button" className="btn btn-secondary small" onClick={() => setConverting(idea)}>
                        Converter
                      </button>
                    )
                  )}
                </div>
              </article>
            ))}
          </div>
        ))}
      {editing && <IdeaForm idea={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={reload} />}
      {converting && (
        <ConvertIdea
          idea={converting}
          onClose={() => setConverting(null)}
          onDone={() => {
            setConverting(null);
            reload();
          }}
        />
      )}
    </>
  );
}
