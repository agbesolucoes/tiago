# Central de Organização — plano do produto

## Escopo e premissas
Administrador inicial: Tiago Deotti. Conta Google prevista: tdeottis@gmail.com. Fuso: America/Sao_Paulo. Aplicação privada e responsiva. A conta ChatGPT autentica o acesso inicial; OAuth Google será uma autorização separada. Demonstração usa dados de exemplo, não compromissos reais.

## Versão implementada
Dashboard, indicadores, agenda local, cadastro e edição de tarefas, projetos e ideias, lista e Kanban, pesquisa, filtros por projeto/prioridade e status de ideias, conversão de ideia em tarefa/projeto preservando a origem, conflitos entre compromissos locais, armazenamento D1 por usuário e auditoria das gravações. Telas principais são o protótipo navegável. Dados de demonstração não são gravados.

## Limitações e itens pendentes
Esta versão NÃO atende ainda aos critérios completos do MVP. Não há OAuth Google, sincronização, bot Telegram, arquivos Drive, recorrências, participantes, lembretes, checklist, comentários, anexos, exclusão, filtros por responsável/período, recuperação de backup automatizada ou gestão de equipe. Nenhuma integração aparece conectada. Não há dados externos reais nem notificações enviadas.

## Arquitetura
Interface React/Vinext; servidor Cloudflare Workers; banco D1; acesso privado via autenticação ChatGPT. API /api/records com consulta e gravação, autorização por owner, validação de título/tipo, proteção de origem em mutações e auditoria atômica. Não armazenar credenciais no navegador. Integrações futuras em rotas de servidor com tokens cifrados e segredos do ambiente.

## Modelo atual
records(id, owner, kind, payload JSON, created_at, updated_at): task/project/idea/event. audit(id, owner, record_id, action, created_at). O payload guarda título, descrição, status, prioridade, projeto, início/término e origem. Este modelo facilita o primeiro protótipo; normalizar antes de ampliar colaboração e consultas.

## Modelo alvo
users; workspaces; memberships(role); projects; tasks(assignee,priority,due_at,status,source_event_id,source_idea_id); checklist_items; comments; ideas(category,status,origin); tags; idea_tags; events(start,end,timezone,remote_id,calendar_id,sync_status); attachments(drive_file_id,parent_id); meeting_notes(agenda,summary,decisions); integration_accounts(encrypted_tokens); telegram_links; pending_confirmations(expires_at); processed_updates(unique update_id); sync_jobs(idempotency_key,attempts,error,next_attempt); audit_log.
Todos os registros compartilhados devem possuir workspace_id; acesso checado em cada operação. Datas persistidas em UTC, interpretadas/apresentadas em São Paulo. Decisões convertidas mantêm vínculo com o encontro.

## Google: plano de integração
1. Criar projeto Google Cloud, habilitar Calendar e Drive, configurar tela de consentimento e cliente OAuth web. Configurar GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY e redirect URI no domínio publicado.
2. Authorization Code com state vinculado à sessão e PKCE. Consentimento explícito; verificar identidade da conta escolhida. Usar openid/email e escopos calendar.calendarlist.readonly, calendar.events e drive.file. Drive file permite apenas arquivos criados pela aplicação ou escolhidos pelo usuário via Picker; não varrer todo o Drive.
3. Selecionar calendários. Sync inicial paginado, syncToken incremental e tratamento de 410 com reconstrução. Watch subscriptions renovadas por job periódico. Persistir IDs e estados, outbox e idempotência. Convites apenas ao clicar ação explícita (sendUpdates apropriado).
4. Criar/reutilizar Central de Organização e subpastas Projetos, Compromissos, Ideias, Documentos gerais. Não alterar ACL. Picker para arquivos existentes; upload streaming ao Drive. Banco mantém vínculo; pauta, decisões e resumo geram registro associado.
5. Confirmação de sucesso só após resposta do Google e persistência dos vínculos. Exibir pendente/erro, repetir falhas transitórias com backoff e tratar token revogado. Desconectar revoga token e desativa jobs.

## Telegram: plano de integração
Criar bot no BotFather e configurar TELEGRAM_BOT_TOKEN e TELEGRAM_WEBHOOK_SECRET no servidor. Registrar webhook HTTPS validando X-Telegram-Bot-Api-Secret-Token. Usuário autenticado gera código de vínculo aleatório, único e curto; bot associa telegram user_id, nunca por nome. Comandos apenas em conversa privada e por usuário autorizado.
Deduplicar update_id com índice único. Interpretar comandos de texto, datas relativas em São Paulo; pedir campos essenciais ausentes. Evento passa a pending_confirmation e mostra data exata/início/término antes de gravar. Cancelamentos/exclusões confirmados. Conclusão ambígua mostra opções. Idempotência deve abranger criação remota e local. Nunca dizer que agendou antes da resposta Calendar.

## Backlog e sequência
P0 (atual): experiência e armazenamento do núcleo.
P0: normalização, validação robusta de schemas, testes de isolamento, login Google/OAuth e cifragem de tokens.
P0: Google Calendar bidirecional, recorrências, lembretes, conflitos e sincronização idempotente.
P0: Drive e registros de reunião; vínculo de decisões com tarefas.
P0: Telegram, vínculo seguro, confirmações, consulta diária e deduplicação.
P0: observabilidade, backups/restore, testes completos em celular e serviços reais.
P1: checklist/comentários/histórico visível, anexos e filtros completos.
P2: áudios, automações avançadas, colaboração ampliada e produtividade.

## Estimativa de planejamento — não é orçamento contratado
MVP integral: 6–10 semanas após credenciais e escopo fechados; 240–400 horas. Cenário ilustrativo a R$100–180/h: R$24.000–72.000. Operação: reservar R$100–500/mês inicialmente, mais eventual uso de IA/transcrição. Valores são hipóteses de planejamento, não preços consultados de fornecedores; validar quotas, hospedagem e volume antes de contratar. A versão inicial desenvolvida nesta sessão cobre apenas o núcleo acima.

## Configuração e manutenção
Manifesto .openai/hosting.json define D1 DB. Migrations Drizzle versionadas, aplicadas no deploy. Instalar com script install-dependencies do Sites; gerar schema com db:generate; build pelo build-site do Sites. Secrets configurados via ambiente do servidor, nunca em Git. Rotas requerem usuário autenticado. Backup deve exportar D1 regularmente, cifrar arquivos e testar restauração em banco isolado; ainda pendente. Auditoria atual registra operação e ID, não valores anteriores.

## Validação para liberar MVP
Testar CRUD e isolamento entre dois usuários; falha de banco preserva formulário; evento Telegram confirmado aparece no Calendar e dashboard; alteração Google retorna por sync; retransmissão de update não duplica; idea convertida preserva origem; horário relativo/fuso correto; conflito e ambiguidades; Drive sem alteração de ACL; revogação OAuth; backoff; restauração backup; responsividade e acessibilidade. Não declarar MVP pronto sem estes fluxos reais.
