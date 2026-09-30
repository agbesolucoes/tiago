# Configurar o bot do Telegram

Leva uns 5 minutos. Precisa da Central já publicada no domínio (`<APP_URL>`).

## 1. Criar o bot

1. No Telegram, abra uma conversa com **@BotFather** e envie `/newbot`.
2. Nome: `Central de Organização`. Usuário: algo terminado em `bot`, como `CentralTiagoBot`.
3. O BotFather responde com o **token** (`123456:ABC...`). Ele dá controle total do bot: não compartilhe.
4. Opcional: envie `/setcommands`, escolha o bot e cole:

```
hoje - Compromissos e tarefas de hoje
tarefa - Criar tarefa (ex.: ligar para o contador amanhã)
ideia - Guardar ideia
evento - Criar compromisso (ex.: reunião sexta das 9h às 10h)
concluir - Concluir tarefa
cancelar - Cancelar compromisso
ajuda - Ver os comandos
```

## 2. Guardar os segredos no servidor

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN       # cole o token do BotFather
openssl rand -hex 32                              # gera o segredo do webhook
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # cole o segredo gerado
```

No `wrangler.jsonc`, em `vars`, adicione `"TELEGRAM_BOT_USERNAME": "CentralTiagoBot"` (sem @) e publique de novo.

## 3. Ligar

1. Na Central, **Configurações → Telegram → Registrar o bot no Telegram** (só dono ou administrador, uma vez).
2. Cada pessoa clica em **Ligar meu Telegram** e envia o código ao bot. O código vale 15 minutos e serve uma vez só.
3. Teste com `/hoje` e `/tarefa testar o bot amanhã`.

O bot só responde em conversa privada e só a contas ligadas. O vínculo usa o número da conta do Telegram, nunca o nome.
