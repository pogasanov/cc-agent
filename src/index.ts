import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { createServer } from './webhooks/server.js';
import { initQueue, startWorker, closeQueue, recoverStalledJobs } from './queue/setup.js';
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

  // Recover stale jobs BEFORE starting the worker
  await recoverStalledJobs();

  // Now start the worker to process jobs
  startWorker();

  logger.info('cc-agent ready');

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // Prevent double shutdown
    shuttingDown = true;
    logger.info(`Shutting down (${signal})...`);
    // Stop worker first so no new processing starts
    await closeQueue();
    await server.close();
    await stopTelegramBot();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Suppress BullMQ lock renewal errors after job kill (harmless noise)
process.on('unhandledRejection', (err: any) => {
  if (err?.message?.includes('could not renew lock')) {
    logger.debug?.(`Suppressed lock renewal error: ${err.message}`) ;
    return;
  }
  logger.error(`Unhandled rejection: ${err}`);
});

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
