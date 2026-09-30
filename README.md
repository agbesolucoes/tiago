# tiago — Central de Organização (backend, etapa 2)

Backend normalizado da Central de Organização: login Google, workspaces e API de tarefas, projetos, ideias e compromissos. Roda em Cloudflare Workers com D1 e Drizzle, a mesma stack do protótipo. A especificação está em `PROJETO.md` e o plano desta etapa em `plano/etapa-2-banco-e-login.md`.

## Rodar

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha as credenciais do Google
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm test                         # testes no runtime do Workers com D1 local
```

## Login

`GET /auth/login` redireciona ao Google (Authorization Code + PKCE + state + nonce, escopos `openid email profile`). O `id_token` recebido em `/auth/callback` tem `iss`, `aud`, `exp`, `nonce` e `email_verified` validados. Só entram os e-mails de `ALLOWED_EMAILS`: o primeiro vira owner do workspace inicial e os demais entram como membros. A sessão é um cookie `HttpOnly; Secure; SameSite=Lax`, e o banco guarda apenas o hash do token. `POST /auth/logout` encerra a sessão.

No Google Cloud, cadastre o redirect URI `<APP_URL>/auth/callback`. Os escopos de Calendar e Drive ficam para a etapa 3, numa autorização separada.

## API

Todas as rotas exigem sessão. O workspace é o do usuário, ou o informado em `X-Workspace-Id` se ele for membro. Mutações exigem JSON e recusam `Origin` de outro site.

| Rota | O que faz |
|---|---|
| `GET /api/me` | usuário, workspace, papel e fuso |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` | projetos (`?status=&q=`) |
| `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id` | tarefas (`?status=&priority=&projectId=&assigneeId=&dueFrom=&dueTo=&q=`) |
| `GET/POST /api/ideas`, `GET/PATCH/DELETE /api/ideas/:id` | ideias com etiquetas (`?status=&category=&q=`) |
| `POST /api/ideas/:id/convert` | `{ "to": "task" \| "project" }` cria o registro com `sourceIdeaId` e marca a ideia como convertida |
| `GET/POST /api/events`, `GET/PATCH/DELETE /api/events/:id` | compromissos (`?from=&to=&q=`); criar ou editar devolve `conflicts` |
| `GET /api/dashboard` | contagens do painel e compromissos de hoje |
| `GET /api/search?q=` | busca em tudo |

Datas: aceita ISO com offset (`2026-10-01T09:00:00-03:00`) ou hora local (`2026-10-01T09:00`), interpretada no fuso do workspace (America/Sao_Paulo). O banco grava ms UTC e as respostas saem em ISO UTC.

Excluir exige papel owner ou admin. Cada gravação e sua linha em `audit_log` (com valores anteriores e novos) vão num mesmo `batch` atômico do D1.

## Integração com o protótipo

O código não depende das telas. Para juntar com o repositório do protótipo: copiar `src/db`, `src/auth`, `src/api`, `src/lib` e `migrations`, montar `app` (Hono) nas rotas de servidor do Vinext, ou manter este Worker na frente, e trocar as chamadas a `/api/records` nas telas pelas rotas acima. O modelo antigo `records` fica sem uso.
