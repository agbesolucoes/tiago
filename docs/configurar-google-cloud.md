# Configurar o Google Cloud para a Central de Organização

Este passo a passo cria as credenciais que a Central usa para o login com Google e para a sincronização com o Google Agenda. Faça com a conta que vai administrar o projeto (prevista: tdeottis@gmail.com). Leva uns 15 minutos.

Antes de começar, tenha em mãos o **domínio** onde a Central vai ficar, por exemplo `https://central.seudominio.com.br`. Abaixo ele aparece como `<APP_URL>`.

## 1. Criar o projeto

1. Abra <https://console.cloud.google.com/> e entre com a conta administradora.
2. No seletor de projetos, no topo, clique em **Novo projeto**.
3. Nome: `Central de Organização`. Clique em **Criar** e selecione o projeto quando ele aparecer.

## 2. Ativar as APIs

1. Menu **APIs e serviços → Biblioteca**.
2. Procure **Google Calendar API** e clique em **Ativar**.
3. Procure **Google Drive API** e clique em **Ativar**.
4. Procure **Google Picker API** e clique em **Ativar** (é o seletor "Escolher do Drive").

## 3. Tela de consentimento (Google Auth Platform)

1. Menu **APIs e serviços → Tela de consentimento OAuth** (ou **Google Auth Platform → Branding**).
2. Tipo de usuário: **Externo**.
3. Nome do app: `Central de Organização`. E-mail de suporte e e-mail de contato: o da conta administradora.
4. Domínios autorizados: o domínio do `<APP_URL>`, sem `https://` (ex.: `seudominio.com.br`).
5. Em **Acesso a dados** (ou **Escopos**), adicione:
   - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/drive.file` (só os arquivos que a Central cria ou que você escolhe)
6. Em **Público** (ou **Usuários de teste**), deixe o app em **Teste** e adicione os e-mails de quem vai usar a Central. No modo Teste, só esses e-mails conseguem autorizar, o que basta para uso privado.

> No modo Teste, o Google expira a autorização do Agenda a cada 7 dias e a Central pede para conectar de novo. Para evitar isso, publique o app e peça a verificação do Google para os escopos do Agenda. Dá para fazer isso depois, com a Central já funcionando.

## 4. Criar o cliente OAuth

1. Menu **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth** (ou **Google Auth Platform → Clientes**).
2. Tipo de aplicativo: **Aplicativo da Web**. Nome: `Central (produção)`.
3. **Origens JavaScript autorizadas**: `<APP_URL>`
4. **URIs de redirecionamento autorizados** (os dois):
   - `<APP_URL>/auth/callback` (login)
   - `<APP_URL>/integrations/google/callback` (Google Agenda)
5. Clique em **Criar** e copie o **ID do cliente** e a **Chave secreta do cliente**.

Para testar no computador, crie um segundo cliente igual com `http://localhost:5173` no lugar do `<APP_URL>`.

## 5. Guardar as credenciais no servidor

As credenciais nunca vão para o Git. No terminal, dentro do projeto:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID        # cole o ID do cliente
npx wrangler secret put GOOGLE_CLIENT_SECRET    # cole a chave secreta
openssl rand -base64 32                          # gera a chave de cifragem
npx wrangler secret put TOKEN_ENCRYPTION_KEY    # cole a chave gerada
```

Para o seletor "Escolher do Drive" (opcional; sem ele, o envio de arquivos funciona igual):

1. **APIs e serviços → Credenciais → Criar credenciais → Chave de API**. Em **Restrições do aplicativo**, escolha **Sites** e adicione `<APP_URL>/*`. Em **Restrições de API**, marque só **Google Picker API**.
2. O número do projeto está em **Painel do projeto → Informações do projeto → Número do projeto**.

```bash
npx wrangler secret put GOOGLE_PICKER_API_KEY   # cole a chave de API
npx wrangler secret put GOOGLE_PROJECT_NUMBER   # cole o número do projeto
```

Guarde a `TOKEN_ENCRYPTION_KEY` num gerenciador de senhas. Se ela se perder, as contas Google conectadas precisam ser conectadas de novo.

No `wrangler.jsonc`, ajuste `APP_URL` para o domínio e `ALLOWED_EMAILS` para os e-mails que podem entrar (o primeiro vira dono).

## 6. Conferir

1. Abra `<APP_URL>` e entre com Google.
2. Vá em **Configurações → Conectar Google Agenda**, marque as permissões do Agenda e do Drive e confirme.
3. A agenda principal aparece marcada. Crie um compromisso na Central e veja se ele surge no Google Agenda em alguns segundos; crie um no Google e clique em **Sincronizar agora**.
4. Em **Configurações → Google Drive**, clique em **Criar a pasta da Central** e envie um arquivo; ele aparece na pasta `Central de Organização/Documentos gerais` do seu Drive.
