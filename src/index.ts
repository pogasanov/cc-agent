import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { createServer } from './webhooks/server.js';
import { initQueue, closeQueue } from './queue/setup.js';
import { initTelegramBot, stopTelegramBot } from './telegram/bot.js';
import { initBridge } from './telegram/bridge.js';
import { initLinearClient } from './linear/client.js';
import { initExecutor } from './claude/executor.js';
import { initGit } from './git/operations.js';

async function main(): Promise<void> {
  logger.info('cc-agent starting...');

  const config = loadConfig();

  // Initialize all modules
  initLinearClient(config);
  initGit(config);
  initExecutor(config);
  initQueue(config);
  initBridge(config);

  await initTelegramBot(config);
  const server = await createServer(config);

  logger.info('cc-agent ready');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Shutting down (${signal})...`);
    await stopTelegramBot();
    await server.close();
    await closeQueue();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
