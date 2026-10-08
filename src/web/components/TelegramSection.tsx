import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp, useResource } from "../state";
import { Icon } from "./Icon";
import { Badge } from "./ui";

interface TelegramStatus {
  enabled: boolean;
  botUsername: string | null;
  linked: boolean;
  username: string | null;
  dailySummary: boolean;
  reminders: boolean;
}

interface LinkCode {
  code: string;
  expiresAt: string;
  deepLink: string | null;
}

export function TelegramSection() {
  const { canDelete, toast } = useApp();
  const { data, reload, setData } = useResource<TelegramStatus>("/api/integrations/telegram");
  const [code, setCode] = useState<LinkCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Enquanto o código está na tela, confere de tempos em tempos se o bot já recebeu.
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(async () => {
      if (Date.parse(code.expiresAt) < Date.now()) {
        setCode(null);
        return;
      }
      const next = await api.get<TelegramStatus>("/api/integrations/telegram").catch(() => null);
      if (next?.linked) {
        setData(next);
        setCode(null);
        toast("Telegram ligado à Central.");
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [code, setData, toast]);

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
  const bot = data.botUsername ? `@${data.botUsername}` : "o bot";

  return (
    <section className="card settings-section">
      <header className="settings-head">
        <div>
          <h2>Telegram</h2>
          <p className="muted small">Registre tarefas, ideias e compromissos por mensagem e receba o resumo do dia às 8h. Cada pessoa liga o próprio Telegram.</p>
        </div>
        <Badge tone={data.linked ? "ok" : data.enabled ? "neutral" : "warn"}>{data.linked ? "Ligado" : data.enabled ? "Não ligado" : "Não configurado"}</Badge>
      </header>

      {!data.enabled && <p className="muted small">O bot ainda não foi configurado no servidor. O passo a passo está no guia de publicação.</p>}

      {data.enabled && data.linked && (
        <>
          <dl className="facts">
            <div>
              <dt>Conta</dt>
              <dd>{data.username ? `@${data.username}` : "Ligada"}</dd>
            </div>
          </dl>
          <label className="check-line">
            <input
              type="checkbox"
              checked={data.dailySummary}
              disabled={busy === "summary"}
              onChange={(e) =>
                run("summary", async () => {
                  const r = await api.patch<{ dailySummary: boolean }>("/api/integrations/telegram", { dailySummary: e.target.checked });
                  setData({ ...data, dailySummary: r.dailySummary });
                })
              }
            />
            <span>Receber o resumo do dia às 8h (só quando houver algo no dia)</span>
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={data.reminders}
              disabled={busy === "reminders"}
              onChange={(e) =>
                run("reminders", async () => {
                  const r = await api.patch<{ reminders: boolean }>("/api/integrations/telegram", { reminders: e.target.checked });
                  setData({ ...data, reminders: r.reminders });
                })
              }
            />
            <span>Receber os lembretes de compromissos e prazos de tarefas</span>
          </label>
          <p className="muted small telegram-help">
            Comandos: /hoje, /tarefa, /ideia, /evento, /concluir, /cancelar e /ajuda. Compromissos e cancelamentos só são gravados depois que você confirma no Telegram.
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={!!busy}
              onClick={() => {
                if (!confirm("Desligar o Telegram da Central? O bot deixa de aceitar seus comandos.")) return;
                run("unlink", async () => {
                  await api.del("/api/integrations/telegram");
                  reload();
                });
              }}
            >
              Desligar
            </button>
          </div>
        </>
      )}

      {data.enabled && !data.linked && (
        <>
          {code ? (
            <div className="link-code">
              <p>
                Abra {bot} no Telegram e envie o código abaixo. Ele vale por 15 minutos e esta tela atualiza sozinha.
              </p>
              <code className="link-code-value">/vincular {code.code}</code>
              <div className="settings-actions">
                {code.deepLink && (
                  <a className="btn btn-primary" href={code.deepLink} target="_blank" rel="noreferrer">
                    <Icon name="send" size={16} /> Abrir no Telegram
                  </a>
                )}
                <button type="button" className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(`/vincular ${code.code}`).then(() => toast("Copiado."))}>
                  Copiar
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!!busy}
                onClick={() => run("code", async () => setCode(await api.post<LinkCode>("/api/integrations/telegram/code", {})))}
              >
                Ligar meu Telegram
              </button>
            </div>
          )}
        </>
      )}

      {data.enabled && canDelete && (
        <div className="telegram-admin">
          <button
            type="button"
            className="btn btn-ghost small"
            disabled={!!busy}
            onClick={() =>
              run("webhook", async () => {
                await api.post("/api/integrations/telegram/webhook", {});
                toast("Bot registrado no Telegram.");
              })
            }
          >
            {busy === "webhook" ? "Registrando…" : "Registrar o bot no Telegram"}
          </button>
          <span className="muted small">Faça uma vez depois de publicar, ou se o bot parar de responder.</span>
        </div>
      )}
    </section>
  );
}
