import { useEffect, useState, type FormEvent } from "react";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useSearchParams } from "react-router";
import { api, ApiError } from "./api";
import { Icon } from "./components/Icon";
import { Loading } from "./components/ui";
import { AgendaPage } from "./pages/Agenda";
import { DashboardPage } from "./pages/Dashboard";
import { IdeasPage } from "./pages/Ideas";
import { LoginPage } from "./pages/Login";
import { MarketPage } from "./pages/Market";
import { ProjectsPage } from "./pages/Projects";
import { SearchPage } from "./pages/Search";
import { SettingsPage } from "./pages/Settings";
import { TasksPage } from "./pages/Tasks";
import { AppProvider, useApp } from "./state";
import { roleLabel, type Me } from "./types";

const nav = [
  { to: "/", label: "Painel", icon: "home" },
  { to: "/tarefas", label: "Tarefas", icon: "check" },
  { to: "/projetos", label: "Projetos", icon: "folder" },
  { to: "/ideias", label: "Ideias", icon: "bulb" },
  { to: "/agenda", label: "Agenda", icon: "calendar" },
  { to: "/mercado", label: "Mercado", icon: "map" },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .get<Me>("/api/me")
        .then(setMe)
        .catch((e: ApiError) => (e.status === 401 || e.status === 403 ? setMe(null) : setFailed(e.message)));
    load();
    const onUnauthorized = () => setMe(null);
    window.addEventListener("central:unauthorized", onUnauthorized);
    return () => window.removeEventListener("central:unauthorized", onUnauthorized);
  }, []);

  if (failed) return <main className="login"><p className="error-note">{failed}</p></main>;
  if (me === undefined) return <main className="login"><Loading /></main>;
  if (me === null) return <LoginPage />;

  return (
    <AppProvider me={me}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<DashboardPage />} />
            <Route path="tarefas" element={<TasksPage />} />
            <Route path="projetos" element={<ProjectsPage />} />
            <Route path="ideias" element={<IdeasPage />} />
            <Route path="agenda" element={<AgendaPage />} />
            <Route path="mercado" element={<MarketPage />} />
            <Route path="busca" element={<SearchPage />} />
            <Route path="configuracoes" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}

function Layout() {
  const { me } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  const search = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) navigate(`/busca?q=${encodeURIComponent(q.trim())}`);
  };
  const logout = async () => {
    await fetch("/auth/logout", { method: "POST" });
    location.href = "/";
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="20" height="20">
              <path d="M9 16.5l4.5 4.5L23 11.5" stroke="currentColor" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>Central</span>
        </div>
        <nav className="side-nav" aria-label="Principal">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"}>
              <Icon name={n.icon} /> {n.label}
            </NavLink>
          ))}
        </nav>
        <NavLink to="/configuracoes" className="side-settings">
          <Icon name="settings" /> Configurações
        </NavLink>
        <div className="side-foot">
          <div className="who">
            <span className="who-name">{me.user.name ?? me.user.email}</span>
            <span className="muted small">{roleLabel[me.workspace.role]}</span>
          </div>
          <button type="button" className="icon-btn" onClick={logout} aria-label="Sair" title="Sair">
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="brand topbar-brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="18" height="18">
                <path d="M9 16.5l4.5 4.5L23 11.5" stroke="currentColor" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </span>
          <form className="search-box" onSubmit={search} role="search">
            <Icon name="search" size={16} />
            <input type="search" placeholder="Buscar tarefas, projetos, ideias…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
          </form>
          <NavLink to="/configuracoes" className="icon-btn topbar-mobile" aria-label="Configurações">
            <Icon name="settings" />
          </NavLink>
          <button type="button" className="icon-btn topbar-mobile" onClick={logout} aria-label="Sair">
            <Icon name="logout" />
          </button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Principal">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"}>
            <Icon name={n.icon} size={20} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
