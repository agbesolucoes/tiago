import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useApp } from "../state";
import { formatDay, localDate, localTime } from "../time";
import type { CalendarEvent } from "../types";
import { Icon } from "./Icon";
import { ErrorNote, Loading, Modal } from "./ui";

interface Decision {
  id?: string;
  text: string;
  taskId?: string | null;
}

interface Notes {
  agenda: string | null;
  summary: string | null;
  decisions: Decision[];
  updatedAt: string | null;
}

export function MeetingNotes({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  const { toast } = useApp();
  const [loaded, setLoaded] = useState(false);
  const [agenda, setAgenda] = useState("");
  const [summary, setSummary] = useState("");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const apply = (n: Notes) => {
    setAgenda(n.agenda ?? "");
    setSummary(n.summary ?? "");
    setDecisions(n.decisions);
    setDirty(false);
  };

  useEffect(() => {
    let active = true;
    api
      .get<Notes>(`/api/events/${event.id}/notes`)
      .then((n) => {
        if (!active) return;
        apply(n);
        setLoaded(true);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [event.id]);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { agenda: agenda || null, summary: summary || null, decisions: decisions.filter((d) => d.text.trim()).map((d) => ({ ...(d.id && { id: d.id }), text: d.text })) };
      const saved = await api.put<Notes>(`/api/events/${event.id}/notes`, body);
      apply(saved);
      if (e) toast("Registro salvo.");
      return saved;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function toTask(d: Decision) {
    let current: Decision | undefined = d;
    if (dirty || !d.id) {
      // Salva antes para a decisão ganhar um id no servidor.
      const saved = await save();
      if (!saved) return;
      current = saved.decisions.find((x) => x.text === d.text.trim() || x.text === d.text);
    }
    if (!current?.id) return;
    try {
      const res = await api.post<{ notes: Notes }>(`/api/events/${event.id}/notes/decisions/${current.id}/task`, {});
      apply(res.notes);
      toast("Tarefa criada a partir da decisão.");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const change = (i: number, text: string) => {
    setDecisions((list) => list.map((d, j) => (j === i ? { ...d, text } : d)));
    setDirty(true);
  };

  return (
    <Modal
      title="Registro da reunião"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Fechar
          </button>
          <button type="submit" form="notes-form" className="btn btn-primary" disabled={saving || !loaded}>
            {saving ? "Salvando…" : "Salvar registro"}
          </button>
        </>
      }
    >
      <p className="muted small notes-sub">
        {event.title} · {formatDay(localDate(event.startAt))} {localTime(event.startAt)}
      </p>
      <ErrorNote message={error} />
      {!loaded && !error && <Loading />}
      {loaded && (
        <form id="notes-form" className="form" onSubmit={save}>
          <label className="field">
            <span className="field-label">Pauta</span>
            <textarea rows={3} value={agenda} onChange={(e) => (setAgenda(e.target.value), setDirty(true))} placeholder="Assuntos a tratar" />
          </label>
          <label className="field">
            <span className="field-label">Resumo</span>
            <textarea rows={4} value={summary} onChange={(e) => (setSummary(e.target.value), setDirty(true))} placeholder="O que foi conversado" />
          </label>
          <div className="field">
            <span className="field-label">Decisões</span>
            <ul className="decision-list">
              {decisions.map((d, i) => (
                <li key={d.id ?? `novo-${i}`}>
                  <input value={d.text} onChange={(e) => change(i, e.target.value)} aria-label={`Decisão ${i + 1}`} maxLength={1000} />
                  {d.taskId ? (
                    <Link className="decision-task done" to={`/tarefas?q=${encodeURIComponent(d.text.slice(0, 40))}`} onClick={onClose}>
                      <Icon name="check" size={14} /> Tarefa
                    </Link>
                  ) : (
                    <button type="button" className="btn btn-secondary small" onClick={() => toTask(d)} disabled={!d.text.trim() || saving}>
                      Criar tarefa
                    </button>
                  )}
                  {!d.taskId && (
                    <button type="button" className="icon-btn small" onClick={() => (setDecisions((l) => l.filter((_, j) => j !== i)), setDirty(true))} aria-label={`Remover decisão ${i + 1}`}>
                      <Icon name="x" size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-ghost small add-decision" onClick={() => (setDecisions((l) => [...l, { text: "" }]), setDirty(true))}>
              <Icon name="plus" size={14} /> Adicionar decisão
            </button>
            <span className="field-hint">A tarefa criada fica ligada a este compromisso e ao projeto dele.</span>
          </div>
        </form>
      )}
    </Modal>
  );
}
