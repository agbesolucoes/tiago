# Publicar na Hostinger

A Central roda como **Aplicativo web Node.js** da Hostinger (planos Business ou Cloud). O servidor Node usa o mesmo código da versão Cloudflare, com três trocas:

| Na Cloudflare | No servidor Node |
|---|---|
| Banco D1 | Arquivo SQLite (`central.db`) |
| Backups no R2 | Pasta `backups/` no servidor e cópia no Google Drive do dono |
| Cron Triggers | Agendador dentro do próprio app (a cada 5 min, backup às 3h, resumo às 8h de Brasília) |

## 1. Criar o app

1. No hPanel, **Sites → Adicionar site → Aplicativo web Node.js**.
2. Escolha **Importar do GitHub** e o repositório `agbesolucoes/tiago`, no branch que for publicado.
3. Configurações de build:
   - **Framework:** Outro (Other)
   - **Versão do Node:** 22 (ou 24). A 18 e a 20 não servem.
   - **Comando de build:** `npm run build`
   - **Arquivo de entrada:** `dist/server/index.mjs`
4. Ligue o domínio ao app no próprio hPanel. O endereço final com `https://` é o `APP_URL`.

## 2. Variáveis de ambiente

Em **Variáveis de ambiente** do app:

| Nome | Valor |
|---|---|
| `APP_URL` | `https://seudominio.com.br` (sem barra no fim) |
| `ALLOWED_EMAILS` | e-mails que podem entrar, separados por vírgula. O primeiro é o dono. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | do Google Cloud, veja [configurar-google-cloud.md](configurar-google-cloud.md) |
| `TOKEN_ENCRYPTION_KEY` | gere com `openssl rand -base64 32` |
| `BACKUP_ENCRYPTION_KEY` | gere com `openssl rand -base64 32`. **Guarde uma cópia fora do servidor:** sem ela nenhum backup abre. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` | do bot, veja [configurar-telegram.md](configurar-telegram.md). Opcionais. |
| `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER` | seletor de arquivos do Drive. Opcionais. |

Opcionais do servidor Node:

| Nome | Padrão | Para quê |
|---|---|---|
| `DATA_DIR` | `~/central-data` | pasta do banco e dos backups |
| `DATABASE_PATH` | `$DATA_DIR/central.db` | arquivo do banco |
| `BACKUP_DIR` | `$DATA_DIR/backups` | backups cifrados |
| `BACKUP_TO_DRIVE` | `true` | cópia de cada backup no Drive do dono |

**O banco fica fora da pasta do app de propósito.** A Hostinger recria a pasta do build a cada publicação; um banco lá dentro seria apagado. Não aponte `DATA_DIR` para dentro de `domains/.../hbuilds`.

Depois de salvar as variáveis, reinicie o app. Na partida ele cria as tabelas (e aplica migrações novas nas publicações seguintes) e escreve no log uma linha `server.started` com o caminho do banco.

## 3. Conferir

1. Abra `https://seudominio.com.br/api/health`: deve responder `{"ok":true}`.
2. Entre com o Google usando o primeiro e-mail de `ALLOWED_EMAILS`.
3. Em **Configurações**, conecte o Google (Agenda e Drive). A partir daí, cada backup diário também vai para **Central de Organização/Backups** no seu Drive.
4. Em **Configurações → Saúde do sistema**, clique em **Fazer backup agora** e confira se aparece "Conferido".
5. Se usar o Telegram, clique em **Registrar o bot no Telegram**.

## 4. Restaurar um backup

Com o app parado (ou num computador com Node 22):

```bash
BACKUP_ENCRYPTION_KEY=... node scripts/restaurar-backup.mjs central-2026-10-01T06-00-00-000Z-abcd1234.cbk restauracao.sql
node scripts/restaurar-sqlite.mjs restauracao.sql ~/central-data/central.db
```

O segundo comando aplica as migrações que faltarem, troca todo o conteúdo numa única transação (se algo falhar, nada muda) e mostra quantas linhas ficaram em cada tabela. Depois, reinicie o app.

## Limites conhecidos

- Um único processo: o SQLite é local ao servidor, então não rode duas cópias do app apontando para o mesmo banco.
- Se o app ficar parado, os jobs agendados não rodam nesse intervalo. A sincronização com o Google recupera sozinha na volta; lembretes com mais de 1 hora de atraso são descartados.

## Por que existe o `.npmrc`

O `.npmrc` do projeto tem `ignore-scripts=true`. Sem ele, o npm tenta compilar o better-sqlite3 no servidor (`node-gyp rebuild`), e na Hostinger não há compilador: a instalação falha com "Failed to install dependencies". Com ele, o npm usa o binário pronto que já vem no pacote (`prebuilds/linux-x64.node`).
