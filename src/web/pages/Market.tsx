import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Badge, Empty, ErrorNote, Loading, PageHeader } from "../components/ui";
import { useApp, useResource } from "../state";
import { formatDue } from "../time";
import type { MarketStudy, Project } from "../types";

// Tela Mercado: o analista de mercado Omega (public/analista/index.html) roda num iframe do mesmo site.
// Ele avisa por postMessage quando termina um estudo; a Central guarda e pode reabrir depois.

const ANALYST_URL = "/analista/index.html";
/** O mesmo teto da API (abaixo de 2 MB por valor no D1). */
const MAX_STATE = 1_900_000;

type Tone = "ok" | "warn" | "neutral" | "danger";
const verdictTone = (v: string | null): Tone =>
  !v ? "neutral" : /^avan/i.test(v) ? "ok" : /^renego/i.test(v) ? "warn" : /^descart/i.test(v) ? "danger" : "neutral";

interface StudyMessage {
  address: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
  verdict: string | null;
  score: number | null;
  coverage: number | null;
  analyzedAt: string;
  state: unknown;
}

async function gzipBase64(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gunzipBase64(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

const fmt = (n: number, digits: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function MarketPage() {
  const { me, canDelete, toast, reloadProjects, projectName } = useApp();
  const { data: studies, error, reload } = useResource<MarketStudy[]>("/api/market-studies");
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, location.origin);

  const save = useCallback(
    async ({ state, ...summary }: StudyMessage) => {
      try {
        let stateGz: string | null = await gzipBase64(JSON.stringify(state));
        if (stateGz.length > MAX_STATE) stateGz = null;
        const created = await api.post<MarketStudy>("/api/market-studies", { ...summary, stateGz });
        setOpenId(created.id);
        toast(stateGz ? "Estudo salvo na Central." : "Estudo salvo só com o resumo: o relatório completo era grande demais.");
        reload();
      } catch (e) {
        toast(`O estudo não foi salvo: ${(e as Error).message}`, "error");
      }
    },
    [toast, reload],
  );

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== location.origin || ev.source !== frame.current?.contentWindow) return;
      const m = ev.data as { type?: string; estudo?: StudyMessage };
      if (m?.type === "omega:pronto" && me.user.name) post({ type: "omega:config", autor: me.user.name });
      if (m?.type === "omega:estudo" && m.estudo) save(m.estudo);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [me.user.name, save]);

  const open = async (s: MarketStudy) => {
    setBusy(s.id);
    try {
      const full = await api.get<MarketStudy & { stateGz: string | null }>(`/api/market-studies/${s.id}`);
      if (!full.stateGz) throw new Error("este estudo foi salvo só com o resumo. Rode a análise de novo para ver o relatório.");
      post({ type: "omega:abrir", state: JSON.parse(await gunzipBase64(full.stateGz)) });
      setOpenId(s.id);
      frame.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      toast(`Não foi possível abrir: ${(e as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const createProject = async (s: MarketStudy) => {
    setBusy(s.id);
    try {
      const p = await api.post<Project>(`/api/market-studies/${s.id}/project`, {});
      toast(`Projeto "${p.title}" criado.`);
      await reloadProjects();
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: MarketStudy) => {
    if (!confirm(`Excluir o estudo de ${s.address}? Esta ação não pode ser desfeita.`)) return;
    try {
      await api.del(`/api/market-studies/${s.id}`);
      toast("Estudo excluído.");
      if (openId === s.id) setOpenId(null);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const newStudy = () => {
    setOpenId(null);
    setFrameKey((k) => k + 1);
  };

  return (
    <>
      <PageHeader title="Mercado">
        <button type="button" className="btn btn-primary" onClick={newStudy}>
          <Icon name="plus" size={16} /> Novo estudo
        </button>
      </PageHeader>
      <p className="muted market-intro">
        Informe o endereço do imóvel no analista abaixo. Cada estudo concluído fica salvo aqui, e pode virar um projeto para acompanhar a negociação do ponto.
      </p>

      <div className="card market-frame">
        <iframe key={frameKey} ref={frame} src={ANALYST_URL} title="Analista de mercado Omega" />
      </div>

      <h2 className="market-title">Estudos salvos</h2>
      <ErrorNote message={error} />
      {!studies && !error && <Loading />}
      {studies &&
        (studies.length === 0 ? (
          <Empty title="Nenhum estudo salvo ainda.">Os estudos aparecem aqui assim que o analista termina.</Empty>
        ) : (
          <div className="project-grid">
            {studies.map((s) => (
              <article key={s.id} className={`card project-card${openId === s.id ? " is-open" : ""}`}>
                <div className="project-top">
                  <h3>{s.address}</h3>
                  {s.verdict && <Badge tone={verdictTone(s.verdict)}>{s.verdict}</Badge>}
                </div>
                <p className="muted small">
                  {[s.city, formatDue(s.analyzedAt)].filter(Boolean).join(" · ")}
                  {s.score !== null && (
                    <>
                      {" · "}matriz {fmt(s.score, 1)}/5{s.coverage !== null && s.coverage < 1 ? ` (${fmt(s.coverage * 100, 0)}% dos pesos)` : ""}
                    </>
                  )}
                </p>
                <div className="project-foot">
                  {s.hasState ? (
                    <button type="button" className="btn btn-ghost small" onClick={() => open(s)} disabled={busy === s.id}>
                      {busy === s.id ? "Abrindo…" : openId === s.id ? "Aberto acima" : "Abrir relatório"}
                    </button>
                  ) : (
                    <span className="muted small">Só o resumo</span>
                  )}
                  {canDelete && (
                    <button type="button" className="btn btn-danger-ghost small" onClick={() => remove(s)}>
                      Excluir
                    </button>
                  )}
                </div>
                {s.projectId ? (
                  <Link className="link-arrow" to={`/tarefas?projeto=${s.projectId}`}>
                    {projectName(s.projectId) ?? "Ver projeto"} <Icon name="arrowRight" size={14} />
                  </Link>
                ) : (
                  <button type="button" className="btn btn-ghost small" onClick={() => createProject(s)} disabled={busy === s.id}>
                    <Icon name="folder" size={14} /> Criar projeto para este ponto
                  </button>
                )}
              </article>
            ))}
          </div>
        ))}
    </>
  );
}
