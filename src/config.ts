import { z } from 'zod';
import 'dotenv/config';

const configSchema = z.object({
  // Linear
  LINEAR_API_KEY: z.string().startsWith('lin_api_'),
  LINEAR_AGENT_USER_ID: z.string().uuid(),
  LINEAR_TEAM_ID: z.string().uuid(),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().regex(/^-?\d+$/),

  // GitHub
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),

  // Paths
  REPO_PATH: z.string().min(1),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Server
  WEBHOOK_PORT: z.coerce.number().int().positive().default(3000),
  WEBHOOK_BASE_URL: z.string().url(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse(process.env);
}
