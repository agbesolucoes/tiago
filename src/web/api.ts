export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Sem conexão. Verifique a internet e tente de novo.");
  }
  if (res.status === 401) {
    window.dispatchEvent(new Event("central:unauthorized"));
    throw new ApiError(401, "Sua sessão expirou. Entre de novo.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, messageFor(res.status, data), data.issues ?? []);
  return data as T;
}

function messageFor(status: number, data: { error?: string; issues?: { path: string; message: string }[] }) {
  if (status === 400 && data.issues?.length) return data.issues.map((i) => i.message).join("; ");
  if (status === 403) return "Você não tem permissão para isso.";
  if (status === 404) return "Registro não encontrado. Ele pode ter sido excluído.";
  if (status === 409) return data.error ?? "Conflito com outra alteração.";
  if (status >= 500) return "O servidor falhou ao salvar. Seus dados continuam no formulário; tente de novo.";
  return data.error ?? "Algo deu errado.";
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: (path: string) => request<void>("DELETE", path),
};

export function qs(params: Record<string, string | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}
