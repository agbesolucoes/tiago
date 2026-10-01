import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Badge, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useApp, useResource } from "../state";
import { formatDue } from "../time";
import { priorityLabel, type Priority } from "../types";

type Status = "analyzing" | "ready" | "failed" | "applied" | "discarded";

interface ProposedTask {
  title: string;
  description: string | null;
  priority: Priority;
  assigneeId: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  projectId: string | null;
  projectRef: string | null;
  checklist: string[];
}

interface ProposedProject {
  ref: string;
  title: string;
  description: string | null;
  priority: Priority;
}

interface Draft {
  id: string;
  source: "web" | "telegram";
  sourceName: string;
  eventId: string | null;
  status: Status;
  error: string | null;
  canRetry: boolean;
  proposal?: { summary: string; projects: ProposedProject[]; tasks: ProposedTask[]; notes: string[] } | null;
  result?: { projectIds: string[]; taskIds: string[] } | null;
  taskCount: number;
  projectCount: number;
  createdAt: string;
}

interface Overview {
  enabled: boolean;
  instructions: string | null;
  drafts: Draft[];
}

const statusInfo: Record<Status, { label: string; tone: "neutral" | "accent" | "warn" | "danger" | "ok" }> = {
  analyzing: { label: "Analisando", tone: "accent" },
  ready: { label: "Para revisar", tone: "warn" },
  failed: { label: "Falhou", tone: "danger" },
  applied: { label: "Criado", tone: "ok" },
  discarded: { label: "Descartado", tone: "neutral" },
};

const priorities: Priority[] = ["low", "medium", "high", "urgent"];

/** Lê o arquivo como base64 (sem o prefixo data:). */
function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("Não consegui ler o arquivo."));
    r.readAsDataURL(file);
  });
}

export function SecretaryPage() {
  const [params, setParams] = useSearchParams();
  const draftId = params.get("proposta");
  const overview = useResource<Overview>("/api/secretary");

  const open = (id: string | null) => setParams(id ? { proposta: id } : {}, { replace: false });

  return (
    <>
      <PageHeader title="Secretária">
        {draftId && (
          <button type="button" className="btn btn-secondary" onClick={() => open(null)}>
            <Icon name="plus" size={16} /> Nova ata
          </button>
        )}
      </PageHeader>
      <ErrorNote message={overview.error} />
      {!overview.data && !overview.error && <Loading />}
      {overview.data && (
        <div className="secretary">
          {!overview.data.enabled && (
            <div className="card secretary-off">
              <Icon name="alert" size={18} />
              <div>
                <strong>A secretária ainda não está ligada.</strong>
                <p className="muted small">Falta colocar a chave da API do Claude (ANTHROPIC_API_KEY) nas variáveis do servidor. Depois de salvar a chave, reimplante o app.</p>
              </div>
            </div>
          )}
          {draftId ? (
            <DraftView key={draftId} id={draftId} onChange={overview.reload} />
          ) : (
            overview.data.enabled && <NewMinutes onCreated={(d) => (overview.reload(), open(d.id))} />
          )}
          <RecentDrafts drafts={overview.data.drafts} current={draftId} onOpen={open} />
          <Instructions initial={overview.data.instructions} />
        </div>
      )}
    </>
  );
}

// ---------- Envio da ata ----------

function NewMinutes({ onCreated }: { onCreated: (d: Draft) => void }) {
  const { toast } = useApp();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const eventId = params.get("evento");
  const fromMeeting = (location.state as { text?: string; meeting?: string } | null) ?? null;
  const [text, setText] = useState(fromMeeting?.text ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file && !text.trim()) return setError("Cole o texto da ata ou escolha um arquivo.");
    if (file && file.size > 10 * 1024 * 1024) return setError("O arquivo passa de 10 MB.");
    setBusy(true);
    try {
      const body = file ? { file: { name: file.name, data: await readFile(file) } } : { text };
      const draft = await api.post<Draft>("/api/secretary/analyze", { ...body, ...(eventId && { eventId }) });
      toast("Ata enviada. A secretária está lendo.");
      onCreated(draft);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card secretary-input form" onSubmit={submit}>
      <div>
        <h2 className="section-title">Enviar uma ata</h2>
        <p className="muted small">A secretária lê a ata e propõe tarefas e projetos. Nada é criado antes de você revisar e confirmar.</p>
      </div>
      {eventId && (
        <p className="secretary-meeting small">
          <Icon name="calendar" size={14} /> As tarefas ficarão ligadas à reunião{fromMeeting?.meeting ? ` “${fromMeeting.meeting}”` : ""}.{" "}
          <button type="button" className="link-btn" onClick={() => navigate("/secretaria", { replace: true })}>
            Desligar
          </button>
        </p>
      )}
      <label className="field">
        <span className="field-label">Texto da ata</span>
        <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Cole aqui a ata ou as anotações da reunião" disabled={!!file || busy} maxLength={200_000} />
      </label>
      <div className="secretary-file">
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file ? (
          <span className="chip secretary-chip">
            <Icon name="file" size={14} /> {file.name}
            <button type="button" className="icon-btn small" aria-label="Remover arquivo" onClick={() => (setFile(null), fileRef.current && (fileRef.current.value = ""))}>
              <Icon name="x" size={14} />
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Icon name="upload" size={16} /> Escolher arquivo
          </button>
        )}
        <span className="muted small">PDF, Word (.docx) ou texto, até 10 MB.</span>
      </div>
      <ErrorNote message={error} />
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Enviando…" : "Analisar ata"}
        </button>
      </div>
    </form>
  );
}

// ---------- Revisão ----------

interface Row extends ProposedTask {
  include: boolean;
  /** Valor do seletor de projeto: "", "id:<projeto>" ou "ref:<novo>". */
  project: string;
}

function DraftView({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, error, setData } = useResource<Draft>(`/api/secretary/drafts/${id}`);
  const { toast } = useApp();

  // Enquanto analisa, consulta de novo a cada poucos segundos.
  useEffect(() => {
    if (data?.status !== "analyzing") return;
    const t = setTimeout(async () => {
      try {
        const next = await api.get<Draft>(`/api/secretary/drafts/${id}`);
        setData(next);
        if (next.status !== "analyzing") onChange();
      } catch {
        setData({ ...data });
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [data, id, setData, onChange]);

  async function retry() {
    try {
      setData(await api.post<Draft>(`/api/secretary/drafts/${id}/retry`, {}));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <section className="card secretary-draft">
      <header className="secretary-draft-head">
        <div>
          <h2 className="section-title">{data.sourceName}</h2>
          <p className="muted small">
            {data.source === "telegram" ? "Enviada pelo Telegram" : "Enviada pela Central"} · {formatDue(data.createdAt)}
          </p>
        </div>
        <Badge tone={statusInfo[data.status].tone}>{statusInfo[data.status].label}</Badge>
      </header>
      {data.status === "analyzing" && (
        <div className="loading" role="status">
          <span className="spinner" /> A secretária está lendo a ata. Isso costuma levar menos de um minuto.
        </div>
      )}
      {data.status === "failed" && (
        <>
          <ErrorNote message={`Não deu para analisar: ${data.error ?? "erro desconhecido"}.`} />
          {data.canRetry && (
            <div>
              <button type="button" className="btn btn-secondary" onClick={retry}>
                <Icon name="sync" size={16} /> Tentar de novo
              </button>
            </div>
          )}
        </>
      )}
      {data.status === "discarded" && <p className="muted">Esta proposta foi descartada.</p>}
      {data.status === "applied" && (
        <p>
          <Icon name="check" size={16} /> Criado: {data.result?.taskIds.length ?? 0} {data.result?.taskIds.length === 1 ? "tarefa" : "tarefas"}
          {data.result?.projectIds.length ? ` e ${data.result.projectIds.length} ${data.result.projectIds.length === 1 ? "projeto" : "projetos"}` : ""}.{" "}
          <Link to="/tarefas">Ver tarefas</Link>
        </p>
      )}
      {data.status === "ready" && data.proposal && <Review draft={data} onDone={(d) => (setData(d), onChange())} />}
    </section>
  );
}

function Review({ draft, onDone }: { draft: Draft; onDone: (d: Draft) => void }) {
  const { members, projects, toast, reloadProjects } = useApp();
  const proposal = draft.proposal!;
  const [newProjects, setNewProjects] = useState(() => proposal.projects.map((p) => ({ ...p, include: true })));
  const [rows, setRows] = useState<Row[]>(() =>
    proposal.tasks.map((t) => ({ ...t, include: true, project: t.projectId ? `id:${t.projectId}` : t.projectRef ? `ref:${t.projectRef}` : "" })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<Row>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const activeRefs = new Set(newProjects.filter((p) => p.include && p.title.trim()).map((p) => p.ref));
  const chosen = rows.filter((r) => r.include && r.title.trim());
  const chosenProjects = newProjects.filter((p) => p.include && p.title.trim());

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        projects: chosenProjects.map(({ ref, title, description, priority }) => ({ ref, title, description, priority })),
        tasks: chosen.map((r) => {
          const ref = r.project.startsWith("ref:") ? r.project.slice(4) : null;
          return {
            title: r.title,
            description: [r.description, !r.assigneeId && r.assigneeName ? `Responsável citado na ata: ${r.assigneeName}.` : null].filter(Boolean).join("\n\n") || null,
            priority: r.priority,
            assigneeId: r.assigneeId,
            dueAt: r.dueDate,
            projectId: r.project.startsWith("id:") ? r.project.slice(3) : null,
            // Projeto novo desmarcado: a tarefa fica sem projeto.
            projectRef: ref && activeRefs.has(ref) ? ref : null,
            checklist: r.checklist,
          };
        }),
      };
      const res = await api.post<{ taskIds: string[]; projectIds: string[]; draft: Draft }>(`/api/secretary/drafts/${draft.id}/apply`, body);
      if (res.projectIds.length) await reloadProjects();
      toast(`${res.taskIds.length} ${res.taskIds.length === 1 ? "tarefa criada" : "tarefas criadas"}.`);
      onDone(res.draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!confirm("Descartar esta proposta? Nada será criado.")) return;
    try {
      onDone(await api.post<Draft>(`/api/secretary/drafts/${draft.id}/discard`, {}));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <div className="secretary-review">
      {proposal.summary && (
        <div>
          <h3 className="secretary-sub">Resumo</h3>
          <p className="secretary-summary">{proposal.summary}</p>
        </div>
      )}
      {proposal.notes.length > 0 && (
        <div className="secretary-notes">
          <h3 className="secretary-sub">
            <Icon name="alert" size={15} /> Pontos de atenção
          </h3>
          <ul>
            {proposal.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {newProjects.length > 0 && (
        <div>
          <h3 className="secretary-sub">Projetos novos</h3>
          <ul className="secretary-list">
            {newProjects.map((p, i) => (
              <li key={p.ref} className={`secretary-item${p.include ? "" : " off"}`}>
                <input type="checkbox" checked={p.include} onChange={(e) => setNewProjects((l) => l.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} aria-label={`Criar o projeto ${p.title}`} />
                <div className="secretary-fields">
                  <input value={p.title} onChange={(e) => setNewProjects((l) => l.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} aria-label="Título do projeto" maxLength={200} disabled={!p.include} />
                  {p.description && <p className="muted small">{p.description}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="secretary-sub">Tarefas ({rows.length})</h3>
        {rows.length === 0 && <p className="muted">A secretária não encontrou tarefas nesta ata.</p>}
        <ul className="secretary-list">
          {rows.map((r, i) => (
            <li key={i} className={`secretary-item${r.include ? "" : " off"}`}>
              <input type="checkbox" checked={r.include} onChange={(e) => setRow(i, { include: e.target.checked })} aria-label={`Criar a tarefa ${r.title}`} />
              <div className="secretary-fields">
                <input className="secretary-title" value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} aria-label="Título da tarefa" maxLength={200} disabled={!r.include} />
                {r.description && <p className="muted small">{r.description}</p>}
                <div className="secretary-meta">
                  <label>
                    <span className="field-label">Responsável</span>
                    <select value={r.assigneeId ?? ""} onChange={(e) => setRow(i, { assigneeId: e.target.value || null })} disabled={!r.include}>
                      <option value="">Ninguém</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name ?? m.email}
                        </option>
                      ))}
                    </select>
                    {r.assigneeName && !r.assigneeId && <span className="field-hint">Na ata: {r.assigneeName}</span>}
                  </label>
                  <label>
                    <span className="field-label">Prazo</span>
                    <input type="date" value={r.dueDate ?? ""} onChange={(e) => setRow(i, { dueDate: e.target.value || null })} disabled={!r.include} />
                  </label>
                  <label>
                    <span className="field-label">Prioridade</span>
                    <select value={r.priority} onChange={(e) => setRow(i, { priority: e.target.value as Priority })} disabled={!r.include}>
                      {priorities.map((p) => (
                        <option key={p} value={p}>
                          {priorityLabel[p]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="field-label">Projeto</span>
                    <select value={r.project} onChange={(e) => setRow(i, { project: e.target.value })} disabled={!r.include}>
                      <option value="">Sem projeto</option>
                      {newProjects
                        .filter((p) => activeRefs.has(p.ref))
                        .map((p) => (
                          <option key={p.ref} value={`ref:${p.ref}`}>
                            Novo: {p.title}
                          </option>
                        ))}
                      {projects
                        .filter((p) => p.status === "active" || p.status === "paused" || `id:${p.id}` === r.project)
                        .map((p) => (
                          <option key={p.id} value={`id:${p.id}`}>
                            {p.title}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                {r.checklist.length > 0 && (
                  <p className="muted small">
                    <Icon name="checklist" size={13} /> Checklist: {r.checklist.join(" · ")}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <ErrorNote message={error} />
      <div className="secretary-actions">
        <button type="button" className="btn btn-primary" onClick={apply} disabled={busy || (!chosen.length && !chosenProjects.length)}>
          {busy ? "Criando…" : `Criar ${chosen.length} ${chosen.length === 1 ? "tarefa" : "tarefas"}${chosenProjects.length ? ` e ${chosenProjects.length} ${chosenProjects.length === 1 ? "projeto" : "projetos"}` : ""}`}
        </button>
        <button type="button" className="btn btn-ghost" onClick={discard} disabled={busy}>
          Descartar
        </button>
      </div>
    </div>
  );
}

// ---------- Histórico e instruções ----------

function RecentDrafts({ drafts, current, onOpen }: { drafts: Draft[]; current: string | null; onOpen: (id: string) => void }) {
  if (!drafts.length) return null;
  return (
    <section className="card secretary-recent">
      <h2 className="section-title">Atas recentes</h2>
      <ul>
        {drafts.map((d) => (
          <li key={d.id}>
            <button type="button" className={`secretary-recent-item${d.id === current ? " current" : ""}`} onClick={() => onOpen(d.id)}>
              <span className="secretary-recent-name">
                <Icon name={d.source === "telegram" ? "send" : "file"} size={14} /> {d.sourceName}
              </span>
              <span className="muted small">{formatDue(d.createdAt)}</span>
              <Badge tone={statusInfo[d.status].tone}>{statusInfo[d.status].label}</Badge>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Instructions({ initial }: { initial: string | null }) {
  const { canDelete, toast } = useApp();
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  if (!canDelete) return null;

  async function save() {
    setBusy(true);
    try {
      const res = await api.put<{ instructions: string | null }>("/api/secretary/settings", { instructions: value || null });
      setSaved(res.instructions ?? "");
      setValue(res.instructions ?? "");
      toast("Instruções da secretária salvas.");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card secretary-instructions">
      <summary>Personalizar a secretária</summary>
      <p className="muted small">
        Escreva aqui como a secretária deve trabalhar: estilo dos títulos, quem costuma ser responsável pelo quê, o que ignorar. Se você já tem instruções de uma secretária no ChatGPT, pode colar o texto delas aqui.
      </p>
      <textarea rows={8} value={value} onChange={(e) => setValue(e.target.value)} maxLength={20_000} placeholder="Ex.: Sempre que a ata citar o Tiago, ele é o responsável. Títulos curtos, no infinitivo." />
      <div>
        <button type="button" className="btn btn-secondary" onClick={save} disabled={busy || value === saved}>
          {busy ? "Salvando…" : "Salvar instruções"}
        </button>
      </div>
    </details>
  );
}
