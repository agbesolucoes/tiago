export interface Env {
  DB: D1Database;
  /** URL pública do app, ex.: https://central.exemplo.com.br (usada no redirect URI). */
  APP_URL: string;
  /** E-mails autorizados a entrar, separados por vírgula. O primeiro vira owner do workspace inicial. */
  ALLOWED_EMAILS: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** "true" libera /auth/dev-login em localhost, para desenvolver sem Google. Nunca em produção. */
  DEV_LOGIN?: string;
  ASSETS?: Fetcher;
}
