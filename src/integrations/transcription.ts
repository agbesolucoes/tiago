// Transcrição de gravações de reunião pela AssemblyAI: o áudio sobe para lá, a transcrição roda do lado deles
// e a Central consulta até ficar pronta. Depois o texto segue para a secretária (runAnalysis).

import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { secretaryDrafts } from "../db/schema";
import type { Env } from "../env";
import { recordError } from "../lib/log";
import { runAnalysis } from "./secretary";

const API = "https://api.assemblyai.com/v2";
/** Gravações de até 300 MB (uma reunião de 3 horas gravada no celular fica bem abaixo disso). */
export const MAX_RECORDING_BYTES = 300 * 1024 * 1024;
const POLL_MS = 5000;
/** Desiste de esperar depois disso; a transcrição de 1 hora costuma levar poucos minutos. */
const GIVE_UP_MS = 3 * 60 * 60_000;
/** Sem sinal de vida por esse tempo, a transcrição é dada como perdida (o envio caiu antes de chegar à AssemblyAI). */
export const TRANSCRIPTION_STALE = 30 * 60_000;

export function transcriptionEnabled(env: Env) {
  return !!env.ASSEMBLYAI_API_KEY;
}

/** Trocado nos testes por um serviço falso. */
export const assemblyFetch: { impl: typeof fetch } = { impl: (input, init) => fetch(input, init) };

export class TranscriptionError extends Error {}

async function call<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await assemblyFetch.impl(`${API}${path}`, { ...init, headers: { authorization: env.ASSEMBLYAI_API_KEY!, ...init.headers } });
  } catch {
    throw new TranscriptionError("não consegui falar com o serviço de transcrição; tente de novo");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401) throw new TranscriptionError("a chave do serviço de transcrição (ASSEMBLYAI_API_KEY) foi recusada");
  if (!res.ok) throw new TranscriptionError(`o serviço de transcrição falhou (${data.error ?? `HTTP ${res.status}`})`);
  return data;
}

/** Envia o áudio (em streaming quando vem da tela) e devolve o endereço interno da AssemblyAI. */
export async function uploadRecording(env: Env, body: ReadableStream | Uint8Array) {
  const init = { method: "POST", body: body as BodyInit, headers: { "content-type": "application/octet-stream" }, duplex: "half" } as RequestInit;
  const { upload_url } = await call<{ upload_url: string }>(env, "/upload", init);
  return upload_url;
}

export async function startTranscript(env: Env, audioUrl: string) {
  const body = { audio_url: audioUrl, language_code: "pt", speech_models: ["universal-3-5-pro", "universal-2"], speaker_labels: true };
  const { id } = await call<{ id: string }>(env, "/transcript", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return id;
}

interface Transcript {
  status: "queued" | "processing" | "completed" | "error";
  text: string | null;
  error?: string;
  utterances?: { speaker: string; text: string; start: number }[] | null;
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "[01:23] Pessoa A: ..." por fala; sem separação de locutores, o texto corrido. */
export function formatTranscript(t: Pick<Transcript, "text" | "utterances">) {
  if (t.utterances?.length) return t.utterances.map((u) => `[${clock(u.start)}] Pessoa ${u.speaker}: ${u.text.trim()}`).join("\n");
  return (t.text ?? "").trim();
}

type Draft = typeof secretaryDrafts.$inferSelect;
export type DraftDone = (draft: Draft) => Promise<unknown>;

/**
 * Consulta a transcrição de um rascunho uma vez. Pronta: grava o texto e roda a análise (e chama onDone).
 * Com erro: marca o rascunho como falho. Ainda processando: não faz nada. Devolve true quando terminou.
 */
export async function advanceTranscription(deps: { db: Db; env: Env }, draftId: string, onDone?: DraftDone) {
  const { db, env } = deps;
  const draft = await db.query.secretaryDrafts.findFirst({ where: eq(secretaryDrafts.id, draftId) });
  if (!draft || draft.status !== "transcribing" || !draft.transcriptId) return true;
  let t: Transcript;
  try {
    t = await call<Transcript>(env, `/transcript/${draft.transcriptId}`);
  } catch (e) {
    // Falha de rede numa consulta não derruba a transcrição: a próxima consulta tenta de novo.
    if (!(e instanceof TranscriptionError)) await recordError(db, "transcricao", e);
    return false;
  }
  if (t.status === "queued" || t.status === "processing") {
    // Sinal de vida: o cron só retoma transcrições que ninguém consulta há alguns minutos.
    await db.update(secretaryDrafts).set({ updatedAt: Date.now() }).where(and(eq(secretaryDrafts.id, draft.id), eq(secretaryDrafts.status, "transcribing")));
    return false;
  }
  const text = t.status === "completed" ? formatTranscript(t) : "";
  const failed = t.status === "error" || !text;
  const claimed = await db
    .update(secretaryDrafts)
    .set(
      failed
        ? { status: "failed", error: t.status === "error" ? `a transcrição falhou (${t.error ?? "erro desconhecido"})` : "não encontrei fala na gravação", updatedAt: Date.now() }
        : { status: "analyzing", inputText: text, inputKind: "transcript", updatedAt: Date.now() },
    )
    .where(and(eq(secretaryDrafts.id, draft.id), eq(secretaryDrafts.status, "transcribing")))
    .returning({ id: secretaryDrafts.id });
  // Outra consulta já tratou esta transcrição.
  if (!claimed.length) return true;
  const done = failed ? await db.query.secretaryDrafts.findFirst({ where: eq(secretaryDrafts.id, draft.id) }) : await runAnalysis(deps, draft.id, { kind: "transcript", text });
  if (done && onDone) await onDone(done).catch((e) => recordError(db, "secretaria aviso", e));
  return true;
}

/** Sobe a gravação, começa a transcrição e acompanha até o fim. Nunca lança: erros viram rascunho falho. */
export async function transcribeRecording(deps: { db: Db; env: Env; sleep?: (ms: number) => Promise<void> }, draftId: string, audio: ReadableStream | Uint8Array | null, onDone?: DraftDone) {
  const { db, env } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  try {
    if (audio) {
      const url = await uploadRecording(env, audio);
      const transcriptId = await startTranscript(env, url);
      await db.update(secretaryDrafts).set({ transcriptId, updatedAt: Date.now() }).where(eq(secretaryDrafts.id, draftId));
    }
    const started = Date.now();
    while (!(await advanceTranscription(deps, draftId, onDone))) {
      if (Date.now() - started > GIVE_UP_MS) throw new TranscriptionError("a transcrição demorou demais; envie a gravação de novo");
      await sleep(POLL_MS);
    }
  } catch (e) {
    if (!(e instanceof TranscriptionError)) await recordError(db, "transcricao", e);
    await db
      .update(secretaryDrafts)
      .set({ status: "failed", error: e instanceof TranscriptionError ? e.message : "a transcrição falhou; tente de novo", updatedAt: Date.now() })
      .where(and(eq(secretaryDrafts.id, draftId), eq(secretaryDrafts.status, "transcribing")));
    const failed = await db.query.secretaryDrafts.findFirst({ where: eq(secretaryDrafts.id, draftId) });
    if (failed && onDone) await onDone(failed).catch((err) => recordError(db, "secretaria aviso", err));
  }
}

/**
 * Cron: retoma transcrições que ficaram sem acompanhamento (servidor reiniciado no meio).
 * Só olha as paradas há mais de 2 minutos, para não competir com o acompanhamento normal.
 */
export async function resumeTranscriptions(deps: { db: Db; env: Env }, onDone?: DraftDone) {
  if (!transcriptionEnabled(deps.env)) return 0;
  const stale = await deps.db
    .select({ id: secretaryDrafts.id })
    .from(secretaryDrafts)
    .where(and(eq(secretaryDrafts.status, "transcribing"), isNotNull(secretaryDrafts.transcriptId), lt(secretaryDrafts.updatedAt, Date.now() - 2 * 60_000)))
    .limit(20);
  for (const d of stale) {
    await deps.db.update(secretaryDrafts).set({ updatedAt: Date.now() }).where(eq(secretaryDrafts.id, d.id));
    await advanceTranscription(deps, d.id, onDone);
  }
  return stale.length;
}
