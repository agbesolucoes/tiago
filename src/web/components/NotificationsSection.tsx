import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, useResource } from "../state";
import { formatDue } from "../time";
import { Icon } from "./Icon";
import { Badge } from "./ui";

interface Device {
  id: string;
  endpoint: string;
  label: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
}

interface NotificationsStatus {
  push: { enabled: boolean; publicKey: string | null };
  devices: Device[];
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** iPhone e iPad só recebem alertas com a Central adicionada à Tela de Início. */
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /Android/.test(ua) ? "Android" : isIos() ? "iPhone/iPad" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} no ${os}` : browser;
}

function keyBytes(b64url: string) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

export function NotificationsSection() {
  const { toast } = useApp();
  const { data, reload } = useResource<NotificationsStatus>("/api/notifications");
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!supported()) return setEndpoint(null);
    currentSubscription()
      .then((s) => setEndpoint(s?.endpoint ?? null))
      .catch(() => setEndpoint(null));
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  if (!data) return null;
  const thisDevice = data.devices.find((d) => d.endpoint === endpoint);
  const blocked = supported() && Notification.permission === "denied";

  const enable = () =>
    run("enable", async () => {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("O navegador não liberou os alertas. Libere nas configurações do site e tente de novo.");
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.push.publicKey!) }));
      const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
      await api.post("/api/notifications/devices", { endpoint: json.endpoint, keys: json.keys, label: deviceLabel() });
      setEndpoint(json.endpoint);
      reload();
      const r = await api.post<{ sent: number }>("/api/notifications/test", {});
      toast(r.sent ? "Alertas ativados. Enviamos um alerta de teste." : "Alertas ativados, mas o alerta de teste não chegou ao serviço do navegador.");
    });

  const disable = (d: Device) =>
    run(`off:${d.id}`, async () => {
      await api.del(`/api/notifications/devices/${d.id}`);
      if (d.endpoint === endpoint) {
        await (await currentSubscription())?.unsubscribe();
        setEndpoint(null);
      }
      reload();
      toast("Alertas desligados neste aparelho.");
    });

  return (
    <section className="card settings-section">
      <header className="settings-head">
        <div>
          <h2>Alertas</h2>
          <p className="muted small">
            Avisos no celular e no computador: prazos de tarefas (no horário do prazo; tarefas sem horário às 9h) e compromissos da agenda com lembrete. Cada aparelho é ativado nele mesmo.
          </p>
        </div>
        <Badge tone={thisDevice ? "ok" : "neutral"}>{thisDevice ? "Ativo neste aparelho" : "Desligado neste aparelho"}</Badge>
      </header>

      {!data.push.enabled && <p className="muted small">Os alertas precisam da variável TOKEN_ENCRYPTION_KEY no servidor.</p>}

      {data.push.enabled && !supported() && (
        <p className="muted small">
          {isIos() && !installed()
            ? "No iPhone, toque em Compartilhar e em “Adicionar à Tela de Início”, abra a Central pelo ícone criado e volte aqui para ativar."
            : "Este navegador não recebe alertas. Use Chrome, Edge, Firefox ou Safari atualizados."}
        </p>
      )}
      {blocked && <p className="warn-text small">Os alertas estão bloqueados para este site no navegador. Libere em Configurações do site → Notificações.</p>}

      {data.push.enabled && supported() && !blocked && endpoint !== undefined && (
        <div className="settings-actions">
          {!thisDevice ? (
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={enable}>
              <Icon name="bell" size={16} /> {busy === "enable" ? "Ativando…" : "Ativar alertas neste aparelho"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!!busy}
              onClick={() =>
                run("test", async () => {
                  const r = await api.post<{ sent: number; devices: number }>("/api/notifications/test", {});
                  toast(r.sent ? `Alerta de teste enviado para ${r.sent} aparelho${r.sent > 1 ? "s" : ""}.` : "O alerta de teste não foi entregue.", r.sent ? "ok" : "error");
                  reload();
                })
              }
            >
              {busy === "test" ? "Enviando…" : "Enviar alerta de teste"}
            </button>
          )}
        </div>
      )}

      {data.devices.length > 0 && (
        <ul className="simple-list">
          {data.devices.map((d) => (
            <li key={d.id} className="device-row">
              <div>
                <strong>{d.label ?? "Aparelho"}</strong>
                {d.endpoint === endpoint && <span className="muted small"> · este aparelho</span>}
                <div className="muted small">{d.lastSuccessAt ? `Último alerta: ${formatDue(d.lastSuccessAt).toLowerCase()}` : `Ativado ${formatDue(d.createdAt).toLowerCase()}`}</div>
              </div>
              <button type="button" className="btn btn-danger-ghost small" disabled={!!busy} onClick={() => disable(d)}>
                Desligar
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
