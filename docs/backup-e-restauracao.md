# Backup, restauração e monitoramento

## O que já vem pronto

- **Time Travel do D1:** a Cloudflare guarda o histórico do banco dos últimos 30 dias sem configurar nada. É a forma mais rápida de desfazer um erro recente (veja "Voltar o banco no tempo").
- **Backup diário próprio:** todo dia às 3h (Brasília) a Central copia o banco inteiro para um arquivo, compacta, cifra com AES-256-GCM e grava no R2. Logo depois lê o arquivo de volta, decifra e confere as linhas de cada tabela; só então marca o backup como "Conferido". Ficam os arquivos dos últimos 30 dias, e nunca menos que os 7 mais recentes.
- **Saúde do sistema** (Configurações, só para o dono da instalação): último backup, histórico com botão para baixar o arquivo, fila do Google, contas do Telegram e erros das últimas 24 horas.
- **Logs:** cada requisição gera uma linha em JSON com um id (`x-request-id`), guardada no Workers Logs (painel da Cloudflare → Workers → central-organizacao → Logs). Erros também ficam na tabela `app_errors` por 30 dias.

Sessões, códigos do Telegram e dados de vida curta não entram no backup: depois de restaurar, cada pessoa só precisa entrar de novo.

## Configurar (uma vez)

```bash
npx wrangler r2 bucket create central-organizacao-backups
openssl rand -base64 32                             # gera a chave dos backups
npx wrangler secret put BACKUP_ENCRYPTION_KEY       # cole a chave gerada
```

Guarde a `BACKUP_ENCRYPTION_KEY` num gerenciador de senhas, **fora** da Cloudflare. Sem ela, nenhum backup pode ser aberto. Ela é diferente da `TOKEN_ENCRYPTION_KEY`, de propósito.

Depois do deploy, em Configurações → Saúde do sistema, clique em **Fazer backup agora** e confira que aparece "Conferido".

### Aviso quando o site cair

Cadastre `<APP_URL>/api/health` num monitor gratuito (UptimeRobot, Better Stack). Ele responde `{"ok":true}` quando o Worker e o banco estão de pé e 503 quando o banco não responde. Não mostra nenhum dado.

### Cópia fora da Cloudflare (recomendado uma vez por mês)

Em Saúde do sistema, clique em **Baixar** no backup mais recente e guarde o arquivo `.cbk` num lugar separado (Google Drive, HD externo). Ele é cifrado: sem a chave, ninguém lê.

## Restaurar

Sempre teste num **banco separado** antes de mexer no de produção.

1. Baixe o arquivo `.cbk` (Saúde do sistema → Baixar, ou `npx wrangler r2 object get central-organizacao-backups/d1/<arquivo>.cbk --file backup.cbk`).
2. Gere o SQL (Node 22.18 ou mais novo):

   ```bash
   BACKUP_ENCRYPTION_KEY=... node scripts/restaurar-backup.mjs backup.cbk restauracao.sql
   ```

   O script mostra a data do backup, a última migration e quantas linhas cada tabela tem.
3. Crie um banco de teste, aplique as migrations (na ordem) e o SQL:

   ```bash
   npx wrangler d1 create central-restauracao-teste
   for f in migrations/*.sql; do npx wrangler d1 execute central-restauracao-teste --remote --file "$f"; done
   npx wrangler d1 execute central-restauracao-teste --remote --file restauracao.sql
   npx wrangler d1 execute central-restauracao-teste --remote --command "SELECT count(*) FROM tasks"
   ```

   As contagens devem bater com as que o script mostrou. Para testar só no computador: `npx wrangler d1 migrations apply DB --local --persist-to ./restauracao-local` e depois `npx wrangler d1 execute DB --local --persist-to ./restauracao-local --file restauracao.sql`. Ao terminar, apague o banco de teste com `npx wrangler d1 delete central-restauracao-teste`.
4. Conferiu? Para trocar a produção, faça antes um backup manual do estado atual e rode o mesmo `execute --file` no banco `central-organizacao`. O SQL apaga as tabelas do backup e reinsere as linhas numa única execução.

## Voltar o banco no tempo (Time Travel)

Para desfazer algo das últimas horas ou dias, sem arquivo:

```bash
npx wrangler d1 time-travel info central-organizacao                              # ponto atual
npx wrangler d1 time-travel restore central-organizacao --timestamp=2026-10-01T12:00:00-03:00
```

O próprio comando mostra um bookmark para desfazer a volta, se precisar.
