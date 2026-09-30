import { useState } from "react";
import { api } from "../api";
import { useApp, useResource } from "../state";
import { formatDue, localTime } from "../time";
import { Badge } from "./ui";

interface Run {
  id: string;
  trigger: "cron" | "manual";
  status: "running" | "ok" | "failed";
  size: number | null;
  rows: number | null;
  error: string | null;
  startedAt: string;
  downloadable: boolean;
}

interface OpsStatus {
  backups: { configured: boolean; lastOkAt: string | null; recent: Run[] };
  google: { accounts: { email: string; status: string; lastSyncAt: string | null; lastError: string | null }[]; pendingJobs: number; failedJobs: number };
  telegram: { enabled: boolean; links: number };
  errors: { last24h: number; recent: { id: string; source: string; message: string; requestId: string | null; at: string }[] };
}

const DAY = 86_400_000;
const when = (iso: string) => {
  const due = formatDue(iso);
  return localTime(iso) === "00:00" ? `${due} 00:00` : due;
};
const size = (n: number | null) => (n == null ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** "Saúde do sistema": backups, fila do Google, Telegram e erros. Só aparece para o dono da instalação. */
export function SystemHealth() {
  const { toast } = useApp();
  const { data, reload } = useResource<OpsStatus>("/api/ops/status");
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const { backups, google, telegram, errors } = data;
  const stale = !backups.lastOkAt || Date.now() - Date.parse(backups.lastOkAt) > 2 * DAY;
  const tone = !backups.configured || stale || errors.last24h > 0 || google.failedJobs > 0 ? "warn" : "ok";

  async function backupNow() {
    setBusy(true);
    try {
      await api.post("/api/ops/backup", {});
      toast("Backup feito e conferido.");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      reload();
    }
  }

  return (
    <section className="card settings-section">
      <header className="settings-head">
        <div>
          <h2>Saúde do sistema</h2>
          <p className="muted small">Só você vê esta parte, como dono da instalação.</p>
        </div>
        <Badge tone={tone}>{tone === "ok" ? "Tudo certo" : "Precisa de atenção"}</Badge>
      </header>

      <dl className="facts">
        <div>
          <dt>Último backup</dt>
          <dd className={stale ? "danger-text" : undefined}>{!backups.configured ? "Não configurado" : backups.lastOkAt ? when(backups.lastOkAt) : "Nenhum ainda"}</dd>
        </div>
        <div>
          <dt>Fila do Google</dt>
          <dd>
            {google.accounts.length === 0 ? "Não conectado" : google.pendingJobs ? `${google.pendingJobs} para enviar` : "Nada pendente"}
            {google.failedJobs ? <span className="danger-text"> · {google.failedJobs} com erro</span> : null}
          </dd>
        </div>
        <div>
          <dt>Erros em 24 horas</dt>
          <dd className={errors.last24h ? "danger-text" : undefined}>{errors.last24h || "Nenhum"}</dd>
        </div>
      </dl>

      <div className="field">
        <span className="field-label">Backups</span>
        {backups.configured ? (
          <p className="muted small ops-note">Todo dia às 3h o banco inteiro é copiado, cifrado e conferido. Ficam os últimos 30 dias.</p>
        ) : (
          <p className="muted small ops-note">O backup ainda não foi configurado no servidor. O passo a passo está em docs/backup-e-restauracao.md.</p>
        )}
        {backups.recent.length > 0 && (
          <ul className="ops-list">
            {backups.recent.map((r) => (
              <li key={r.id}>
                <span>{when(r.startedAt)}</span>
                <Badge tone={r.status === "ok" ? "ok" : r.status === "failed" ? "danger" : "neutral"}>{r.status === "ok" ? "Conferido" : r.status === "failed" ? "Falhou" : "Rodando"}</Badge>
                <span className="muted small ops-detail">{r.status === "failed" ? r.error : `${r.rows} linhas · ${size(r.size)}${r.trigger === "manual" ? " · manual" : ""}`}</span>
                {r.downloadable && (
                  <a className="small" href={`/api/ops/backups/${r.id}/download`}>
                    Baixar
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {backups.configured && (
          <div className="settings-actions">
            <button type="button" className="btn btn-ghost" onClick={backupNow} disabled={busy}>
              {busy ? "Fazendo backup…" : "Fazer backup agora"}
            </button>
          </div>
        )}
      </div>

      {errors.recent.length > 0 && (
        <div className="field">
          <span className="field-label">Erros recentes</span>
          <ul className="ops-list">
            {errors.recent.map((e) => (
              <li key={e.id}>
                <span>{when(e.at)}</span>
                <span className="ops-detail">
                  <strong>{e.source}</strong> {e.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted small ops-note">
        {telegram.enabled ? `Telegram ativo, ${telegram.links} ${telegram.links === 1 ? "conta ligada" : "contas ligadas"}. ` : "Telegram não configurado. "}
        Para um aviso quando o site cair, cadastre o endereço /api/health num monitor como o UptimeRobot.
      </p>
    </section>
  );
}
