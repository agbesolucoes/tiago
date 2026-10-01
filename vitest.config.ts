import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_URL: "https://app.test",
            ALLOWED_EMAILS: "dono@exemplo.com,membro@exemplo.com",
            GOOGLE_CLIENT_ID: "client-test",
            GOOGLE_CLIENT_SECRET: "secret-test",
            // Os testes não podem herdar o .dev.vars local.
            DEV_LOGIN: "false",
            // Nos testes a fila é processada explicitamente.
            PUSH_ON_WRITE: "false",
            TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            BACKUP_ENCRYPTION_KEY: "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=",
            TELEGRAM_BOT_TOKEN: "123:bot-test",
            TELEGRAM_WEBHOOK_SECRET: "segredo-webhook",
            TELEGRAM_BOT_USERNAME: "CentralTesteBot",
            // A secretária nos testes usa uma resposta pronta (secretaryAi.impl), nunca a API de verdade.
            ANTHROPIC_API_KEY: "sk-ant-teste",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
