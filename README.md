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
| `GET/PATCH/DELETE /api/integrations/google` | status do Google Agenda, agendas sincronizadas e de destino, desconectar |
| `POST /api/integrations/google/sync` | envia a fila e importa agora |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id` | projetos (`?status=&q=`) |
| `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id` | tarefas (`?status=&priority=&projectId=&assigneeId=&dueFrom=&dueTo=&q=`) |
| `GET/POST /api/tasks/:id/checklist`, `PATCH/DELETE /api/tasks/:id/checklist/:itemId`, `PUT /api/tasks/:id/checklist/order` | checklist da tarefa (até 200 itens); a listagem de tarefas traz `checklistTotal`, `checklistDone` e `commentCount` |
| `GET/POST /api/tasks/:id/comments`, `PATCH/DELETE /api/tasks/:id/comments/:commentId` | comentários; só quem escreveu edita; quem escreveu, o dono ou um administrador apaga |
| `GET /api/tasks/:id/history` | histórico da tarefa, da checklist e dos comentários, do mais novo para o mais antigo (vem do `audit_log`) |
| `GET/POST /api/ideas`, `GET/PATCH/DELETE /api/ideas/:id` | ideias com etiquetas (`?status=&category=&q=`) |
| `POST /api/ideas/:id/convert` | `{ "to": "task" \| "project" }` cria o registro com `sourceIdeaId` e marca a ideia como convertida |
| `GET/POST /api/events`, `GET/PATCH/DELETE /api/events/:id` | compromissos (`?from=&to=&q=`, até 2 anos por consulta); séries voltam expandidas, uma linha por ocorrência; criar ou editar devolve `conflicts` |
| `POST /api/events/:id/occurrences/skip` | tira um dia da série (`{ "occurrenceStart" }`) |
| `POST /api/events/:id/occurrences/detach` | altera só um dia da série; vira um compromisso próprio ligado a ela |
| `GET /api/dashboard` | contagens do painel e compromissos de hoje |
| `GET /api/search?q=` | busca em tudo |

Datas: aceita ISO com offset (`2026-10-01T09:00:00-03:00`) ou hora local (`2026-10-01T09:00`), interpretada no fuso do workspace (America/Sao_Paulo). O banco grava ms UTC e as respostas saem em ISO UTC.

Excluir exige papel owner ou admin. Cada gravação e sua linha em `audit_log` (com valores anteriores e novos) vão num mesmo `batch` atômico do D1.

## Google Agenda

Em **Configurações**, o dono ou um administrador conecta a conta Google (autorização separada do login, com acesso offline e só os escopos `calendar.calendarlist.readonly` e `calendar.events`). Os tokens ficam cifrados com AES-GCM (`TOKEN_ENCRYPTION_KEY`).

- **Google → Central:** sync inicial paginado (a partir de 30 dias atrás) e depois incremental com `syncToken`; um 410 refaz o sync completo. Roda a cada 5 minutos (cron) e no botão **Sincronizar agora**. Eventos cancelados no Google são removidos aqui.
- **Central → Google:** criar, editar ou excluir um compromisso grava, no mesmo batch, uma tarefa na fila `sync_jobs` (uma por evento; edições seguidas se juntam). A fila é enviada logo após a gravação e pelo cron. O id do evento no Google deriva do id local, então um reenvio nunca duplica. Falhas transitórias voltam com backoff (1 min, 2 min, 4 min… até 6 h, 8 tentativas); as permanentes marcam o compromisso com erro. Token revogado marca a conta e a fila espera a reconexão.
- O compromisso só aparece como sincronizado depois da resposta do Google e do vínculo gravado. Convites nunca são enviados (`sendUpdates=none`).
- Uma alteração local que ainda está na fila vence a versão do Google na próxima importação.
- Desconectar revoga o token no Google, apaga a conta e a fila; os compromissos continuam na Central.

O passo a passo das credenciais está em [docs/configurar-google-cloud.md](docs/configurar-google-cloud.md).

## Repetição e lembretes

- **Séries:** um compromisso pode repetir todo dia, semana (com dias escolhidos), mês ou ano, a cada N, sem fim, até uma data ou por N vezes (`repeat` no POST/PATCH). A regra é gravada como RRULE e expandida no fuso do workspace, então 10h continua 10h depois da mudança de horário. Conflitos e o painel consideram cada ocorrência.
- **Um dia só:** editar só uma ocorrência cria uma exceção (`series_id` + `original_start_at`) e acrescenta a data em `exdates` da série; excluir só uma ocorrência acrescenta a data em `exdates`. Excluir a série apaga as exceções junto.
- **Google Agenda:** a série vai com as linhas `RRULE` e `EXDATE`; a exceção criada aqui vai como compromisso avulso. Na importação (`singleEvents=false`), séries do Google viram séries aqui, exceções do Google viram exceções e ocorrências canceladas viram `exdates`. Regras que a tela não sabe editar aparecem como "repetição personalizada" e continuam valendo.
- **Lembretes:** `reminderMinutes` (na hora, 10 min, 30 min, 1 h, 1 dia…) vai para o Google como aviso de pop-up. No Telegram, o cron de 5 minutos manda "Lembrete: … às HH:MM" para quem ligou o Telegram e deixou os lembretes ativos. Cada ocorrência é avisada uma vez por pessoa (`reminder_log`); lembrete com mais de 1 hora de atraso é descartado.

## Google Drive e registros de reunião

A mesma conexão Google pede também `drive.file`: a Central só enxerga arquivos que ela criou ou que alguém escolheu no seletor do Google, e nunca altera o compartilhamento deles. Contas conectadas antes desta etapa aparecem em Configurações com "Falta autorizar" até conectar de novo.

- **Pastas:** na primeira vez, a Central cria no Drive `Central de Organização/` com `Projetos`, `Compromissos`, `Ideias` e `Documentos gerais`. Se alguém apagar uma pasta, ela é recriada no próximo envio.
- **Anexos** em tarefas, projetos, compromissos, ideias e em Configurações (documentos gerais): `POST /api/attachments/upload?parentKind=&parentId=&name=` recebe o arquivo cru (até 100 MB) e repassa em streaming para um upload resumível do Drive, sem guardar nada no Worker. Exige o cabeçalho `x-central-upload: 1`. `POST /api/attachments/link` vincula um arquivo escolhido no seletor. Tirar um anexo desfaz só o vínculo; o arquivo fica no Drive.
- **Seletor do Google (Picker):** aparece quando os segredos `GOOGLE_PICKER_API_KEY` e `GOOGLE_PROJECT_NUMBER` existem. O token de acesso vai para o navegador só na hora de abrir o seletor e não é guardado.
- **Registro da reunião:** em cada compromisso, pauta, resumo e decisões (`GET/PUT /api/events/:id/notes`). `POST /api/events/:id/notes/decisions/:decisionId/task` transforma uma decisão em tarefa com o projeto do compromisso e `source_event_id`; cada decisão vira tarefa uma vez só.

## Telegram

Cada pessoa liga o próprio Telegram em **Configurações → Telegram**: a Central gera um código de 8 caracteres (vale 15 minutos, uso único, guardado só como hash) e o bot associa o `user_id` do Telegram, nunca o nome. O bot só aceita conversa privada e contas ligadas.

- **Webhook** em `POST /integrations/telegram/webhook`, validando `X-Telegram-Bot-Api-Secret-Token` em tempo constante. Cada `update_id` entra em `processed_updates` (chave primária), então uma retransmissão não repete nada; se o processamento falhar antes de gravar, o registro é desfeito para o Telegram tentar de novo.
- **Comandos:** `/hoje`, `/tarefa`, `/ideia`, `/evento`, `/concluir`, `/cancelar`, `/ajuda`. Datas relativas em português (hoje, amanhã, sexta, 12/10, dia 15, 14h, 9h às 10h30) são lidas no fuso do workspace por `src/lib/nl-date.ts`.
- **Confirmações:** compromissos, cancelamentos e conclusões ambíguas viram `pending_confirmations` (vencem em 30 min) com botões. A troca para confirmado é atômica e o compromisso usa o id da confirmação, então tocar duas vezes não duplica nada, nem no Google. Depois de gravar, o bot envia ao Google na hora e só diz "agendado" com a resposta dele; se o Google não confirmar, diz que ficou pendente.
- **Resumo diário:** cron `0 11 * * *` (8h em São Paulo) manda o dia para quem ligou o Telegram e deixou o resumo ativo, só quando há algo. A mesma rodada limpa updates antigos e códigos vencidos.

Passo a passo do bot em [docs/configurar-telegram.md](docs/configurar-telegram.md).

## Monitoramento e backups

- **Logs:** cada requisição gera uma linha JSON com `requestId` (também no cabeçalho `x-request-id`), método, rota, status e duração; `observability` está ligado no `wrangler.jsonc`. Erros 500, falhas do sync, do backup e de envio no Telegram vão também para `app_errors` (30 dias).
- **`GET /api/health`:** público e sem dados, para monitor externo; 503 se o banco não responde.
- **Backup:** cron `0 6 * * *` (3h em Brasília) exporta todas as tabelas (menos sessões e dados de vida curta), compacta com gzip, cifra com AES-256-GCM (`BACKUP_ENCRYPTION_KEY`) e grava no R2 (`BACKUPS`). Em seguida lê de volta e confere as contagens antes de marcar como ok. Retenção de 30 dias, mínimo de 7 arquivos.
- **`/api/ops/*`:** status, backup manual e download do arquivo, só para o dono da instalação (papel owner e primeiro e-mail de `ALLOWED_EMAILS`).
- **Restauração:** `scripts/restaurar-backup.mjs` decifra o arquivo e gera o SQL; o teste `test/ops.test.ts` restaura um backup e compara as linhas.

Passo a passo em [docs/backup-e-restauracao.md](docs/backup-e-restauracao.md).

## Publicar

**Hostinger (Node.js):** passo a passo em [docs/publicar-na-hostinger.md](docs/publicar-na-hostinger.md). `npm run build` gera as telas e o servidor (`dist/server/index.mjs`), e `npm start` sobe o app com SQLite e o agendador. `npm run test:node` testa o servidor Node.

**Cloudflare:**

1. `wrangler d1 create central-organizacao` e copie o `database_id` para o `wrangler.jsonc`. Crie também o bucket dos backups: `wrangler r2 bucket create central-organizacao-backups`.
2. Ajuste `APP_URL` e `ALLOWED_EMAILS` em `vars`.
3. `wrangler secret put` para `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `TOKEN_ENCRYPTION_KEY` (e, para o seletor do Drive, `GOOGLE_PICKER_API_KEY` e `GOOGLE_PROJECT_NUMBER`; para o bot, `TELEGRAM_BOT_TOKEN` e `TELEGRAM_WEBHOOK_SECRET`, veja [docs/configurar-telegram.md](docs/configurar-telegram.md); para os backups, `BACKUP_ENCRYPTION_KEY`) (veja [docs/configurar-google-cloud.md](docs/configurar-google-cloud.md)).
4. `npm run deploy` (build, migrations remotas e deploy).
