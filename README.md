# tiago — Central de Organização

Central de Organização: tarefas, projetos, ideias e agenda num só lugar, com login Google. Telas em React (Vite) e backend em Cloudflare Workers com D1 e Drizzle, publicados juntos num único Worker. A especificação está em [docs/PROJETO.md](docs/PROJETO.md) e o plano desta etapa em [docs/etapa-2-banco-e-login.md](docs/etapa-2-banco-e-login.md).

## Rodar

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha as credenciais do Google (ou use DEV_LOGIN, abaixo)
npm run db:migrate:local
npm run dev                      # telas e API em http://localhost:5173
npm test                         # testes da API no runtime do Workers com D1 local
npm run typecheck
npm run build
```

Para desenvolver sem configurar o Google, coloque `DEV_LOGIN=true` no `.dev.vars` e abra `http://localhost:5173/auth/dev-login`. A rota só responde com essa variável ligada e em localhost; nunca configure `DEV_LOGIN` em produção.

## Telas

Painel (indicadores, próximas tarefas, agenda do dia e tarefas por status), tarefas em lista e Kanban (arrastar no computador, seletor de status no celular) com filtros por projeto, prioridade, status, responsável e prazo, projetos com progresso, ideias com etiquetas e conversão em tarefa ou projeto, agenda semanal com aviso de conflito, e busca geral. O layout é responsivo, com navegação inferior no celular, e segue o tema claro ou escuro do sistema. Se a gravação falhar, o formulário continua aberto com os dados.

## Login

`GET /auth/login` redireciona ao Google (Authorization Code + PKCE + state + nonce, escopos `openid email profile`). O `id_token` recebido em `/auth/callback` tem `iss`, `aud`, `exp`, `nonce` e `email_verified` validados. Só entram os e-mails de `ALLOWED_EMAILS`: o primeiro vira owner do workspace inicial e os demais entram como membros. A sessão é um cookie `HttpOnly; Secure; SameSite=Lax`, e o banco guarda apenas o hash do token. `POST /auth/logout` encerra a sessão.

No Google Cloud, cadastre o redirect URI `<APP_URL>/auth/callback`. Os escopos de Calendar e Drive ficam para a etapa 3, numa autorização separada.

## API

Todas as rotas exigem sessão. O workspace é o do usuário, ou o informado em `X-Workspace-Id` se ele for membro. Mutações exigem JSON e recusam `Origin` de outro site.

| Rota | O que faz |
|---|---|
| `GET /api/me` | usuário, workspace, papel e fuso |
| `GET /api/members` | membros do workspace |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` | projetos (`?status=&q=`) |
| `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id` | tarefas (`?status=&priority=&projectId=&assigneeId=&dueFrom=&dueTo=&q=`) |
| `GET/POST /api/ideas`, `GET/PATCH/DELETE /api/ideas/:id` | ideias com etiquetas (`?status=&category=&q=`) |
| `POST /api/ideas/:id/convert` | `{ "to": "task" \| "project" }` cria o registro com `sourceIdeaId` e marca a ideia como convertida |
| `GET/POST /api/events`, `GET/PATCH/DELETE /api/events/:id` | compromissos (`?from=&to=&q=`); criar ou editar devolve `conflicts` |
| `GET /api/dashboard` | contagens do painel e compromissos de hoje |
| `GET /api/search?q=` | busca em tudo |

Datas: aceita ISO com offset (`2026-10-01T09:00:00-03:00`) ou hora local (`2026-10-01T09:00`), interpretada no fuso do workspace (America/Sao_Paulo). O banco grava ms UTC e as respostas saem em ISO UTC.

Excluir exige papel owner ou admin. Cada gravação e sua linha em `audit_log` (com valores anteriores e novos) vão num mesmo `batch` atômico do D1.

## Publicar

1. `wrangler d1 create central-organizacao` e copie o `database_id` para o `wrangler.jsonc`.
2. Ajuste `APP_URL` e `ALLOWED_EMAILS` em `vars`.
3. `wrangler secret put GOOGLE_CLIENT_ID` e `wrangler secret put GOOGLE_CLIENT_SECRET`.
4. `npm run deploy` (build, migrations remotas e deploy).
