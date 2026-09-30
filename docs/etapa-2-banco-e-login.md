# Etapa 2 — Banco normalizado e login Google

Base: PROJETO.md (modelo alvo, arquitetura e validação). Stack mantida: React/Vinext, Cloudflare Workers, D1, migrations Drizzle.

## 1. Login
- Trocar a autenticação ChatGPT por login Google (OpenID Connect, escopos `openid email profile`), com Authorization Code, PKCE e `state` ligado a um cookie de sessão.
- A sessão fica num cookie `HttpOnly; Secure; SameSite=Lax` com o id de uma linha em `sessions`. Nenhum token no navegador.
- Os escopos de Calendar e Drive **não** entram aqui. Eles serão pedidos depois, numa autorização separada (etapa 3), como o documento prevê.
- Lista de acesso: só os e-mails convidados entram (primeiro administrador: o definido no PROJETO.md).
- Secrets: `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. A `TOKEN_ENCRYPTION_KEY` entra na etapa 3. Não precisa de `SESSION_SECRET`: o token da sessão é aleatório e o banco guarda só o hash.

## 2. Tabelas (primeira leva)
Todas as tabelas compartilhadas têm `workspace_id`. As datas ficam em UTC (inteiro, epoch ms) e são mostradas no fuso America/Sao_Paulo.

| Tabela | Colunas principais |
|---|---|
| users | id, email (único), name, created_at |
| sessions | id, user_id, expires_at, created_at |
| workspaces | id, name, timezone (padrão America/Sao_Paulo) |
| memberships | workspace_id, user_id, role (owner/admin/member), único (workspace_id, user_id) |
| projects | id, workspace_id, title, description, status, priority, created_by, created_at, updated_at |
| tasks | id, workspace_id, project_id?, title, description, status, priority, assignee_id?, due_at?, source_event_id?, source_idea_id?, created_by, timestamps |
| ideas | id, workspace_id, title, description, category, status, origin, converted_to_kind?, converted_to_id?, timestamps |
| events | id, workspace_id, title, start_at, end_at, timezone, all_day, remote_id?, calendar_id?, sync_status (local/pending/synced/error), timestamps |
| tags, idea_tags | etiquetas das ideias |
| audit_log | id, workspace_id, user_id, entity, entity_id, action, before JSON?, after JSON?, created_at |

Checklist, comentários, anexos, reuniões e as tabelas de integração (integration_accounts, telegram_links, pending_confirmations, processed_updates, sync_jobs) ficam para as etapas em que forem usadas.

Mudança em relação ao modelo atual: `audit_log` passa a guardar o valor anterior e o novo. Hoje a auditoria só registra a operação e o id.

## 3. API
- Trocar `/api/records` por rotas por recurso (`/api/tasks`, `/api/projects`, `/api/ideas`, `/api/events`), com validação Zod na entrada e na saída.
- Um middleware único resolve a sessão, o workspace e o papel do usuário. Toda consulta filtra por `workspace_id`.
- Cada gravação e sua linha de auditoria vão num `db.batch` (atômico no D1).
- Converter uma ideia em tarefa ou projeto grava `source_idea_id` e marca a ideia como convertida.

## 4. Migração dos dados
- Padrão: começar com o banco vazio. O PROJETO.md diz que a demonstração usa só dados de exemplo e que eles não são gravados.
- Se alguém tiver cadastrado registros reais no D1 atual, um script lê `records` e copia cada `kind` para a sua tabela, mantendo os ids e o `created_at`.

## 5. Testes (critério para fechar a etapa)
- Isolamento: o usuário A não lê nem altera nada do workspace de B (todas as rotas, com testes automatizados).
- Validação: payload inválido volta 400 e não grava nada; uma falha do banco não perde o formulário.
- Conversão de ideia preserva a origem.
- Datas: um horário salvo em São Paulo volta igual; testar a virada de dia em UTC.
- Ferramentas: Vitest com `@cloudflare/vitest-pool-workers` (D1 local).

## Pendências com o Lucas
- Repositório: decidido aproveitar o código do protótipo; falta exportá-lo do ChatGPT Sites para o GitHub.
- GitHub conectado.
- Confirmar que ninguém cadastrou registros reais no protótipo (o padrão é começar com o banco vazio).
- Domínio de publicação (necessário para o redirect URI do Google).
