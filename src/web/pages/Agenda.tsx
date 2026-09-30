import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { qs } from "../api";
import { Icon } from "../components/Icon";
import { EventForm } from "../components/forms";
import { ErrorNote, Loading, PageHeader } from "../components/ui";
import { useApp, useResource } from "../state";
import { addDays, formatDay, localDate, localTime, startOfWeek, today } from "../time";
import type { CalendarEvent, Conflict } from "../types";

export function AgendaPage() {
  const { projectName } = useApp();
  const [params, setParams] = useSearchParams();
  const week = startOfWeek(params.get("semana") ?? today());
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const { data: events, error, reload } = useResource<CalendarEvent[]>(`/api/events${qs({ from: week, to: addDays(week, 7) })}`);
  const [editing, setEditing] = useState<{ event?: CalendarEvent; date?: string } | null>(null);
  const [warning, setWarning] = useState<Conflict[]>([]);

  // Compromissos que se sobrepõem a outro na semana.
  const conflicting = useMemo(() => {
    const ids = new Set<string>();
    const list = events ?? [];
    for (const a of list)
      for (const b of list)
        if (a.id !== b.id && new Date(a.startAt) < new Date(b.endAt) && new Date(b.startAt) < new Date(a.endAt)) ids.add(a.id);
    return ids;
  }, [events]);

  const goto = (date: string) => setParams(date === startOfWeek(today()) ? {} : { semana: date }, { replace: true });
  const now = today();

  return (
    <>
      <PageHeader title="Agenda">
        <div className="week-nav">
          <button type="button" className="icon-btn" onClick={() => goto(addDays(week, -7))} aria-label="Semana anterior">
            <Icon name="chevronLeft" />
          </button>
          <button type="button" className="btn btn-ghost small" onClick={() => goto(startOfWeek(now))}>
            Hoje
          </button>
          <button type="button" className="icon-btn" onClick={() => goto(addDays(week, 7))} aria-label="Próxima semana">
            <Icon name="chevronRight" />
          </button>
          <span className="week-label">
            {formatDay(week, { day: "numeric", month: "short" })} – {formatDay(addDays(week, 6), { day: "numeric", month: "short", year: "numeric" })}
          </span>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing({ date: days.includes(now) ? now : week })}>
          <Icon name="plus" size={16} /> Novo compromisso
        </button>
      </PageHeader>

      {warning.length > 0 && (
        <div className="warn-note" role="alert">
          <Icon name="alert" size={16} />
          <span>
            Conflito de horário com {warning.map((c) => `“${c.title}” (${localTime(c.startAt)}–${localTime(c.endAt)})`).join(", ")}. O compromisso foi salvo mesmo assim.
          </span>
          <button type="button" className="icon-btn" onClick={() => setWarning([])} aria-label="Fechar aviso">
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      <ErrorNote message={error} />
      {!events && !error && <Loading />}
      {events && (
        <div className="week">
          {days.map((d) => {
            const dayEvents = events.filter((e) => localDate(e.startAt) <= d && localDate(e.endAt) >= d);
            return (
              <section key={d} className={`day card${d === now ? " is-today" : ""}`}>
                <header className="day-head">
                  <span className="day-name">{formatDay(d, { weekday: "short" })}</span>
                  <span className="day-num">{formatDay(d, { day: "numeric" })}</span>
                  <button type="button" className="icon-btn small" onClick={() => setEditing({ date: d })} aria-label={`Novo compromisso em ${formatDay(d)}`}>
                    <Icon name="plus" size={16} />
                  </button>
                </header>
                {dayEvents.length === 0 ? (
                  <p className="day-empty">Livre</p>
                ) : (
                  <ul className="day-events">
                    {dayEvents.map((e) => (
                      <li key={e.id}>
                        <button type="button" className={`event${conflicting.has(e.id) ? " has-conflict" : ""}`} onClick={() => setEditing({ event: e })}>
                          <span className="event-time">
                            {localDate(e.startAt) === d ? localTime(e.startAt) : "…"}–{localDate(e.endAt) === d ? localTime(e.endAt) : "…"}
                          </span>
                          <span className="event-title">{e.title}</span>
                          {e.projectId && <span className="event-project">{projectName(e.projectId)}</span>}
                          {e.syncStatus === "pending" && <span className="event-sync">Enviando ao Google…</span>}
                          {e.syncStatus === "error" && <span className="event-sync error">Erro ao enviar ao Google</span>}
                          {conflicting.has(e.id) && (
                            <span className="event-conflict">
                              <Icon name="alert" size={12} /> Conflito
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
      {editing && (
        <EventForm
          event={editing.event}
          date={editing.date}
          onClose={() => setEditing(null)}
          onSaved={(conflicts) => {
            setWarning(conflicts);
            reload();
          }}
        />
      )}
    </>
  );
}
