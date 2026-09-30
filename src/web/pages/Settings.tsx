import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Badge, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useApp, useResource } from "../state";
import { formatDue } from "../time";
import { roleLabel } from "../types";

interface GoogleStatus {
  connected: boolean;
  email?: string;
  status?: "active" | "revoked" | "error";
  lastError?: string | null;
  lastSyncAt?: string | null;
  defaultCalendarId?: string | null;
  calendars?: { id: string; summary: string; primary: boolean; writable: boolean; selected: boolean }[];
  pendingJobs?: number;
  failedJobs?: number;
}

const notices: Record<string, { text: string; tone: "ok" | "error" }> = {
  conectado: { text: "Google Agenda conectado. A primeira sincronização já começou.", tone: "ok" },
  cancelado: { text: "A conexão foi cancelada na tela do Google.", tone: "error" },
  expirado: { text: "A conexão demorou demais ou foi interrompida. Tente de novo.", tone: "error" },
  escopos: { text: "Para sincronizar, marque as duas permissões do Google Agenda na tela do Google.", tone: "error" },
  erro: { text: "O Google não confirmou a conexão. Tente de novo.", tone: "error" },
};

export function SettingsPage() {
  const { me, members, canDelete, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const { data, error, setData } = useResource<GoogleStatus>("/api/integrations/google");
  const [busy, setBusy] = useState<string | null>(null);
  const notice = notices[params.get("google") ?? ""];

  useEffect(() => {
    if (notice) {
      toast(notice.text, notice.tone);
      setParams({}, { replace: true });
    }
  }, [notice, setParams, toast]);

  async function run(label: string, fn: () => Promise<GoogleStatus | void>) {
    setBusy(label);
    try {
      const next = await fn();
      if (next) setData(next);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  const sync = () =>
    run("sync", async () => {
      const res = await api.post<GoogleStatus & { result?: { imported: number; jobs: { done: number } } }>("/api/integrations/google/sync", {});
      toast("Sincronização concluída.");
      return res;
    });
  const toggle = (id: string, selected: boolean) => run(id, () => api.patch<GoogleStatus>("/api/integrations/google", { calendars: [{ id, selected }] }));
  const setDefault = (id: string) => run("default", () => api.patch<GoogleStatus>("/api/integrations/google", { defaultCalendarId: id || null }));
  const disconnect = () =>
    run("disconnect", async () => {
      if (!confirm("Desconectar o Google Agenda? O acesso será revogado e os compromissos já trazidos continuam na Central.")) return;
      await api.del("/api/integrations/google");
      toast("Google Agenda desconectado.");
      return { connected: false };
    });

  return (
    <>
      <PageHeader title="Configurações" />

      <section className="card settings-section">
        <header className="settings-head">
          <div>
            <h2>Google Agenda</h2>
            <p className="muted small">Compromissos criados aqui vão para a agenda escolhida, e o que muda no Google volta para cá a cada 5 minutos.</p>
          </div>
          {data?.connected && (
            <Badge tone={data.status === "active" ? "ok" : "danger"}>{data.status === "active" ? "Conectado" : data.status === "revoked" ? "Acesso revogado" : "Com erro"}</Badge>
          )}
        </header>
        <ErrorNote message={error} />
        {!data && !error && <Loading />}
        {data && !data.connected && (
          <div className="connect-box">
            <p>Conecte a conta Google para sincronizar os compromissos nos dois sentidos. A Central pede só acesso à lista de agendas e aos eventos; convites nunca são enviados sem você pedir.</p>
            {canDelete ? (
              <a className="btn btn-primary" href="/integrations/google/connect">
                <Icon name="calendar" size={16} /> Conectar Google Agenda
              </a>
            ) : (
              <p className="muted small">Só o dono ou um administrador pode conectar.</p>
            )}
          </div>
        )}
        {data?.connected && (
          <>
            {data.status !== "active" && (
              <div className="error-note" role="alert">
                <Icon name="alert" size={16} /> {data.lastError ?? "A conexão com o Google parou."}
                {canDelete && (
                  <a className="btn btn-secondary small" href="/integrations/google/connect">
                    Conectar de novo
                  </a>
                )}
              </div>
            )}
            <dl className="facts">
              <div>
                <dt>Conta</dt>
                <dd>{data.email}</dd>
              </div>
              <div>
                <dt>Última sincronização</dt>
                <dd>{data.lastSyncAt ? formatDue(data.lastSyncAt) : "Ainda não"}</dd>
              </div>
              <div>
                <dt>Na fila</dt>
                <dd>
                  {data.pendingJobs ? `${data.pendingJobs} para enviar` : "Nada pendente"}
                  {data.failedJobs ? <span className="danger-text"> · {data.failedJobs} com erro</span> : null}
                </dd>
              </div>
            </dl>
            {data.status === "active" && data.lastError && <p className="warn-text small">{data.lastError}</p>}

            <div className="field">
              <span className="field-label">Agenda que recebe os compromissos da Central</span>
              <select value={data.defaultCalendarId ?? ""} onChange={(e) => setDefault(e.target.value)} disabled={!canDelete || busy === "default"}>
                <option value="">Nenhuma (compromissos ficam só aqui)</option>
                {data.calendars
                  ?.filter((c) => c.writable)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.summary}
                    </option>
                  ))}
              </select>
            </div>

            <div className="field">
              <span className="field-label">Agendas trazidas para a Central</span>
              <ul className="calendar-list">
                {data.calendars?.map((c) => (
                  <li key={c.id}>
                    <label>
                      <input type="checkbox" checked={c.selected} disabled={!canDelete || busy === c.id} onChange={(e) => toggle(c.id, e.target.checked)} />
                      <span>{c.summary}</span>
                      {c.primary && <Badge tone="accent">Principal</Badge>}
                      {!c.writable && <span className="muted small">somente leitura</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            <div className="settings-actions">
              <button type="button" className="btn btn-primary" onClick={sync} disabled={!!busy || data.status !== "active"}>
                {busy === "sync" ? "Sincronizando…" : "Sincronizar agora"}
              </button>
              {canDelete && (
                <button type="button" className="btn btn-danger-ghost" onClick={disconnect} disabled={!!busy}>
                  Desconectar
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <section className="card settings-section">
        <header className="settings-head">
          <div>
            <h2>Pessoas</h2>
            <p className="muted small">Quem pode entrar é definido pela lista de e-mails autorizados do servidor.</p>
          </div>
        </header>
        <ul className="simple-list">
          {members.map((m) => (
            <li key={m.id}>
              <span>
                {m.name ?? m.email}
                {m.id === me.user.id && <span className="muted"> (você)</span>}
                <span className="muted small block">{m.email}</span>
              </span>
              <Badge>{roleLabel[m.role]}</Badge>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
