import { useState, type KeyboardEvent } from "react";
import { api } from "../api";
import { useApp, useResource } from "../state";
import { formatDay, localDate, localTime, today } from "../time";
import { priorityLabel, taskStatusLabel, type Priority, type TaskStatus } from "../types";
import { Icon } from "./Icon";
import { ErrorNote, Loading } from "./ui";

interface Item {
  id: string;
  text: string;
  done: boolean;
  position: number;
}

interface Comment {
  id: string;
  body: string;
  userId: string | null;
  authorName: string;
  createdAt: string;
  edited: boolean;
}

interface HistoryEntry {
  id: string;
  entity: "task" | "task_item" | "task_comment";
  action: "create" | "update" | "delete" | "convert";
  userId: string | null;
  userName: string | null;
  before: Record<string, any> | null;
  after: Record<string, any> | null;
  createdAt: string;
}

type Tab = "checklist" | "comments" | "history";

/** Checklist, comentários e histórico de uma tarefa já salva. Cada ação grava na hora. */
export function TaskDetails({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>("checklist");
  const tabs: [Tab, string][] = [
    ["checklist", "Checklist"],
    ["comments", "Comentários"],
    ["history", "Histórico"],
  ];
  return (
    <div className="task-details">
      <div className="tabs" role="tablist" aria-label="Detalhes da tarefa">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} className={`tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "checklist" && <Checklist taskId={taskId} onChanged={onChanged} />}
        {tab === "comments" && <Comments taskId={taskId} onChanged={onChanged} />}
        {tab === "history" && <History taskId={taskId} />}
      </div>
    </div>
  );
}

/** Enter no campo não pode enviar o formulário da tarefa. */
const onEnter = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    fn();
  }
};

function Checklist({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const { toast } = useApp();
  const base = `/api/tasks/${taskId}/checklist`;
  const { data: items, error, setData } = useResource<Item[]>(base);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorNote message={error} />;
  if (!items) return <Loading />;

  const add = () =>
    text.trim() &&
    run(async () => {
      const item = await api.post<Item>(base, { text });
      setData([...items, item]);
      setText("");
    });
  const update = (item: Item, patch: Partial<Item>) =>
    run(async () => {
      const saved = await api.patch<Item>(`${base}/${item.id}`, patch);
      setData(items.map((i) => (i.id === item.id ? saved : i)));
    });
  const move = (index: number, delta: number) =>
    run(async () => {
      const ids = items.map((i) => i.id);
      [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      setData(await api.put<Item[]>(`${base}/order`, { ids }));
    });
  const remove = (item: Item) =>
    run(async () => {
      await api.del(`${base}/${item.id}`);
      setData(items.filter((i) => i.id !== item.id));
    });

  const done = items.filter((i) => i.done).length;
  return (
    <div className="checklist">
      {items.length > 0 && (
        <div className="progress-line" aria-label={`${done} de ${items.length} feitos`}>
          <div className="progress-bar">
            <span style={{ width: `${(done / items.length) * 100}%` }} />
          </div>
          <span className="muted small">
            {done} de {items.length}
          </span>
        </div>
      )}
      <ul className="checklist-items">
        {items.map((item, i) => (
          <li key={item.id} className={item.done ? "is-done" : ""}>
            <input type="checkbox" className="check" checked={item.done} disabled={busy} onChange={() => update(item, { done: !item.done })} aria-label={item.done ? `Desmarcar ${item.text}` : `Marcar ${item.text}`} />
            <input
              className="checklist-text"
              defaultValue={item.text}
              key={item.text}
              maxLength={500}
              aria-label="Texto do item"
              onKeyDown={onEnter(() => (document.activeElement as HTMLElement | null)?.blur())}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (!v) e.target.value = item.text;
                else if (v !== item.text) update(item, { text: v });
              }}
            />
            <div className="checklist-actions">
              <button type="button" className="icon-btn small" onClick={() => move(i, -1)} disabled={busy || i === 0} aria-label={`Subir ${item.text}`}>
                <Icon name="up" size={14} />
              </button>
              <button type="button" className="icon-btn small" onClick={() => move(i, 1)} disabled={busy || i === items.length - 1} aria-label={`Descer ${item.text}`}>
                <Icon name="down" size={14} />
              </button>
              <button type="button" className="icon-btn small" onClick={() => remove(item)} disabled={busy} aria-label={`Remover ${item.text}`}>
                <Icon name="x" size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="add-line">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onEnter(add)} placeholder="Novo item" maxLength={500} aria-label="Novo item da checklist" />
        <button type="button" className="btn btn-secondary" onClick={add} disabled={busy || !text.trim()}>
          Adicionar
        </button>
      </div>
    </div>
  );
}

/** "Hoje 14:05", "12 out 09:30". */
function when(iso: string) {
  const d = localDate(iso);
  const t = localTime(iso);
  if (d === today()) return `Hoje ${t}`;
  const sameYear = d.slice(0, 4) === today().slice(0, 4);
  return `${formatDay(d, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" })} ${t}`;
}

function Comments({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const { me, canDelete, toast } = useApp();
  const base = `/api/tasks/${taskId}/comments`;
  const { data: comments, error, setData } = useResource<Comment[]>(base);
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorNote message={error} />;
  if (!comments) return <Loading />;

  const send = () =>
    body.trim() &&
    run(async () => {
      const c = await api.post<Comment>(base, { body });
      setData([...comments, c]);
      setBody("");
    });
  const save = () =>
    editing &&
    editing.body.trim() &&
    run(async () => {
      const c = await api.patch<Comment>(`${base}/${editing.id}`, { body: editing.body });
      setData(comments.map((x) => (x.id === c.id ? c : x)));
      setEditing(null);
    });
  const remove = (c: Comment) => {
    if (!confirm("Apagar este comentário?")) return;
    run(async () => {
      await api.del(`${base}/${c.id}`);
      setData(comments.filter((x) => x.id !== c.id));
    });
  };

  return (
    <div className="comments">
      {comments.length === 0 && <p className="muted small">Nenhum comentário ainda.</p>}
      <ul className="comment-list">
        {comments.map((c) => {
          const mine = c.userId === me.user.id;
          return (
            <li key={c.id} className="comment">
              <div className="comment-head">
                <strong>{mine ? "Você" : c.authorName}</strong>
                <span className="muted small">
                  {when(c.createdAt)}
                  {c.edited && " · editado"}
                </span>
              </div>
              {editing?.id === c.id ? (
                <div className="comment-edit">
                  <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={3} maxLength={5000} aria-label="Editar comentário" />
                  <div className="comment-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)} disabled={busy}>
                      Cancelar
                    </button>
                    <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !editing.body.trim()}>
                      Salvar comentário
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="comment-body">{c.body}</p>
                  {(mine || canDelete) && (
                    <div className="comment-actions">
                      {mine && (
                        <button type="button" className="link-btn" onClick={() => setEditing({ id: c.id, body: c.body })} disabled={busy}>
                          Editar
                        </button>
                      )}
                      <button type="button" className="link-btn danger" onClick={() => remove(c)} disabled={busy}>
                        Apagar
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      <div className="comment-new">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={5000} placeholder="Escreva um comentário" aria-label="Novo comentário" />
        <button type="button" className="btn btn-secondary" onClick={send} disabled={busy || !body.trim()}>
          <Icon name="send" size={15} /> Comentar
        </button>
      </div>
    </div>
  );
}

const quote = (s: unknown, max = 60) => {
  const t = String(s ?? "");
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
};

/** Transforma um registro do histórico em frases em português. */
function describe(h: HistoryEntry, names: { project: (id: string) => string | null; member: (id: string) => string | null }): string[] {
  const a = h.after ?? {};
  const b = h.before ?? {};
  if (h.entity === "task_item") {
    if (h.action === "create") return [`adicionou ${quote(a.text)} à checklist`];
    if (h.action === "delete") return [`removeu ${quote(b.text)} da checklist`];
    const out: string[] = [];
    if ("done" in a) out.push(`${a.done ? "marcou" : "desmarcou"} ${quote(b.text)}`);
    if ("text" in a) out.push(`trocou o item ${quote(b.text)} por ${quote(a.text)}`);
    return out;
  }
  if (h.entity === "task_comment") {
    if (h.action === "create") return [`comentou ${quote(a.body, 80)}`];
    if (h.action === "delete") return ["apagou um comentário"];
    return ["editou um comentário"];
  }
  if (h.action === "create") return ["criou a tarefa"];
  if (h.action === "delete") return ["excluiu a tarefa"];
  const out: string[] = [];
  const date = (v: unknown) => {
    if (v == null) return null;
    const iso = new Date(v as number | string).toISOString();
    return localTime(iso) === "00:00" ? formatDay(localDate(iso), { day: "numeric", month: "short", year: "numeric" }) : `${formatDay(localDate(iso), { day: "numeric", month: "short", year: "numeric" })} às ${localTime(iso)}`;
  };
  for (const key of Object.keys(a)) {
    const v = a[key];
    switch (key) {
      case "status":
        out.push(`mudou o status de ${taskStatusLabel[b.status as TaskStatus] ?? b.status} para ${taskStatusLabel[v as TaskStatus] ?? v}`);
        break;
      case "priority":
        out.push(`mudou a prioridade de ${priorityLabel[b.priority as Priority] ?? b.priority} para ${priorityLabel[v as Priority] ?? v}`);
        break;
      case "title":
        if (v !== b.title) out.push(`renomeou para ${quote(v)}`);
        break;
      case "description":
        if ((v ?? null) !== (b.description ?? null)) out.push(v ? "editou a descrição" : "apagou a descrição");
        break;
      case "dueAt":
        if ((v ?? null) !== (b.dueAt ?? null)) out.push(v == null ? "tirou o prazo" : `mudou o prazo para ${date(v)}`);
        break;
      case "projectId":
        if ((v ?? null) !== (b.projectId ?? null)) out.push(v ? `pôs no projeto ${names.project(v) ?? "(projeto removido)"}` : "tirou do projeto");
        break;
      case "assigneeId":
        if ((v ?? null) !== (b.assigneeId ?? null)) out.push(v ? `passou a tarefa para ${names.member(v) ?? "outra pessoa"}` : "tirou o responsável");
        break;
    }
  }
  return out;
}

function History({ taskId }: { taskId: string }) {
  const { projectName, memberName, me } = useApp();
  const { data, error } = useResource<HistoryEntry[]>(`/api/tasks/${taskId}/history`);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const lines = data.flatMap((h) => describe(h, { project: projectName, member: memberName }).map((text, i) => ({ key: `${h.id}:${i}`, who: h.userId === me.user.id ? "Você" : (h.userName ?? "Alguém"), text, at: h.createdAt })));
  if (!lines.length) return <p className="muted small">Nada registrado ainda.</p>;
  return (
    <ol className="history">
      {lines.map((l) => (
        <li key={l.key}>
          <span>
            <strong>{l.who}</strong> {l.text}
          </span>
          <time className="muted small" dateTime={l.at}>
            {when(l.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}
