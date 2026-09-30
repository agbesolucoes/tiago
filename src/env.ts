export interface Env {
  DB: D1Database;
  /** URL pública do app, ex.: https://central.exemplo.com.br (usada no redirect URI). */
  APP_URL: string;
  /** E-mails autorizados a entrar, separados por vírgula. O primeiro vira owner do workspace inicial. */
  ALLOWED_EMAILS: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** 32 bytes em base64 para cifrar os tokens do Google (AES-GCM). `openssl rand -base64 32` */
  TOKEN_ENCRYPTION_KEY: string;
  /** Chave de API (restrita ao domínio) e número do projeto Google Cloud para o Google Picker. Opcionais. */
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_PROJECT_NUMBER?: string;
  /** Token do bot (BotFather), segredo do webhook (cabeçalho X-Telegram-Bot-Api-Secret-Token) e @ do bot. Opcionais. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_USERNAME?: string;
  /** Bucket R2 dos backups e chave (32 bytes em base64) que cifra cada arquivo. Sem os dois, o backup fica desligado. */
  BACKUPS?: R2Bucket;
  BACKUP_ENCRYPTION_KEY?: string;
  /** "true" guarda também uma cópia de cada backup no Google Drive do dono da instalação (padrão no servidor Node). */
  BACKUP_TO_DRIVE?: string;
  /** "true" libera /auth/dev-login em localhost, para desenvolver sem Google. Nunca em produção. */
  DEV_LOGIN?: string;
  /** "false" desliga o envio imediato ao Google após cada gravação (fica só o cron). */
  PUSH_ON_WRITE?: string;
  ASSETS?: Fetcher;
}
