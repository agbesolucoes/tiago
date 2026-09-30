import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { setTimeZone } from "./time";
import type { Me, Member, Project } from "./types";

interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error";
}

interface AppState {
  me: Me;
  members: Member[];
  projects: Project[];
  reloadProjects: () => Promise<void>;
  canDelete: boolean;
  toast: (text: string, tone?: Toast["tone"]) => void;
  memberName: (id: string | null) => string | null;
  projectName: (id: string | null) => string | null;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp fora do AppProvider");
  return v;
}

export function AppProvider({ me, children }: { me: Me; children: ReactNode }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  setTimeZone(me.workspace.timezone);

  const reloadProjects = useCallback(async () => {
    setProjects(await api.get<Project[]>("/api/projects"));
  }, []);

  useEffect(() => {
    api.get<Member[]>("/api/members").then(setMembers).catch(() => {});
    reloadProjects().catch(() => {});
  }, [reloadProjects]);

  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const value: AppState = {
    me,
    members,
    projects,
    reloadProjects,
    canDelete: me.workspace.role !== "member",
    toast,
    memberName: (id) => {
      const m = members.find((x) => x.id === id);
      return m ? (m.name ?? m.email) : null;
    },
    projectName: (id) => projects.find((p) => p.id === id)?.title ?? null,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Carrega dados de uma rota da API e recarrega quando a chave muda. */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setError(null);
    api
      .get<T>(path)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [path, version]);
  return { data, error, reload: () => setVersion((v) => v + 1), setData };
}
