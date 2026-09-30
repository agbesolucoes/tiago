import { useRef, useState } from "react";
import { api, ApiError, qs } from "../api";
import { useApp, useResource } from "../state";
import { Icon } from "./Icon";

export interface Attachment {
  id: string;
  name: string;
  mimeType: string | null;
  size: number | null;
  webViewLink: string | null;
  origin: "uploaded" | "linked";
}

interface DriveStatus {
  connected: boolean;
  status?: string;
  driveEnabled?: boolean;
  pickerEnabled?: boolean;
}

type Kind = "project" | "task" | "event" | "idea" | "general";

function formatSize(n: number | null) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function uploadFile(kind: Kind, parentId: string | null, file: File) {
  let res: Response;
  try {
    res = await fetch(`/api/attachments/upload${qs({ parentKind: kind, parentId, name: file.name })}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-central-upload": "1" },
      body: file,
    });
  } catch {
    throw new ApiError(0, "Sem conexão. O arquivo não foi enviado.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.issues?.[0]?.message ?? data.error ?? "O envio falhou.");
  return data as Attachment;
}

// ---------- Google Picker (carregado sob demanda) ----------

declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
}

let pickerLoaded: Promise<void> | null = null;
function loadPicker() {
  pickerLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.onload = () => window.gapi.load("picker", { callback: resolve, onerror: reject });
    s.onerror = () => {
      pickerLoaded = null;
      reject(new Error("Não foi possível carregar o seletor do Google."));
    };
    document.head.appendChild(s);
  });
  return pickerLoaded;
}

async function pickFromDrive(): Promise<string[]> {
  // O token vale 1 hora e só existe nesta chamada; nada é guardado no navegador.
  const cfg = await api.get<{ accessToken: string; apiKey: string; appId: string }>("/api/integrations/google/picker");
  await loadPicker();
  const g = window.google.picker;
  return new Promise((resolve) => {
    const picker = new g.PickerBuilder()
      .addView(new g.DocsView().setIncludeFolders(false))
      .enableFeature(g.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(cfg.accessToken)
      .setDeveloperKey(cfg.apiKey)
      .setAppId(cfg.appId)
      .setLocale("pt-BR")
      .setCallback((data: any) => {
        if (data.action === g.Action.PICKED) resolve(data.docs.map((d: any) => d.id));
        else if (data.action === g.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
}

export function Attachments({ kind, parentId }: { kind: Kind; parentId: string | null }) {
  const { toast } = useApp();
  const list = useResource<Attachment[]>(`/api/attachments${qs({ parentKind: kind, parentId })}`);
  const drive = useResource<DriveStatus>("/api/integrations/google");
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ready = drive.data?.connected && drive.data.status === "active" && drive.data.driveEnabled;

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      setBusy(`Enviando ${file.name}…`);
      try {
        await uploadFile(kind, parentId, file);
        toast(`${file.name} salvo no Drive.`);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    }
    setBusy(null);
    if (input.current) input.current.value = "";
    list.reload();
  }

  async function onPick() {
    try {
      const ids = await pickFromDrive();
      if (!ids.length) return;
      setBusy("Vinculando…");
      for (const driveFileId of ids) await api.post("/api/attachments/link", { parentKind: kind, parentId, driveFileId });
      toast(ids.length > 1 ? "Arquivos vinculados." : "Arquivo vinculado.");
      list.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  async function remove(a: Attachment) {
    if (!confirm(`Tirar “${a.name}” daqui? O arquivo continua no Drive.`)) return;
    try {
      await api.del(`/api/attachments/${a.id}`);
      list.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <div className="attachments">
      <div className="attachments-head">
        <span className="field-label">Anexos</span>
        {ready && (
          <div className="attachments-actions">
            <button type="button" className="btn btn-ghost small" onClick={() => input.current?.click()} disabled={!!busy}>
              <Icon name="upload" size={14} /> Enviar arquivo
            </button>
            {drive.data?.pickerEnabled && (
              <button type="button" className="btn btn-ghost small" onClick={onPick} disabled={!!busy}>
                <Icon name="drive" size={14} /> Escolher do Drive
              </button>
            )}
            <input ref={input} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </div>
        )}
      </div>
      {busy && <p className="muted small">{busy}</p>}
      {list.data && list.data.length > 0 && (
        <ul className="attachment-list">
          {list.data.map((a) => (
            <li key={a.id}>
              <Icon name="file" size={16} />
              <a href={a.webViewLink ?? "#"} target="_blank" rel="noreferrer">
                {a.name}
              </a>
              <span className="muted small">{formatSize(a.size)}</span>
              <button type="button" className="icon-btn small" onClick={() => remove(a)} aria-label={`Tirar ${a.name}`}>
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.data?.length === 0 && ready && <p className="muted small">Nenhum anexo. Os arquivos ficam na pasta da Central no seu Drive.</p>}
      {drive.data && !ready && (
        <p className="muted small">
          {drive.data.connected ? "Conecte o Google de novo em Configurações e autorize o Drive para anexar arquivos." : "Conecte o Google em Configurações para anexar arquivos do Drive."}
        </p>
      )}
    </div>
  );
}
