import { Bot, type BotError, type Context } from 'grammy';
import { type Config } from '../config.js';
import { handleTelegramReply } from './bridge.js';
import { logger } from '../logger.js';

let bot: Bot;

export function getBot(): Bot {
  return bot;
}

export async function initTelegramBot(config: Config): Promise<Bot> {
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Handle all text messages as potential replies to pending questions
  bot.on('message:text', async (ctx) => {
    // Only accept messages from the configured operator
    if (String(ctx.chat.id) !== config.TELEGRAM_CHAT_ID) return;
    await handleTelegramReply(ctx.message.text);
  });

  // Handle callback queries (inline keyboard button presses)
  bot.on('callback_query:data', async (ctx) => {
    if (String(ctx.chat?.id) !== config.TELEGRAM_CHAT_ID) return;
    await ctx.answerCallbackQuery();
    await handleTelegramReply(ctx.callbackQuery.data);
  });

  bot.catch((err: BotError) => {
    logger.error(`Telegram bot error: ${err.message}`);
  });

  // Start polling (non-blocking)
  bot.start();
  logger.info('Telegram bot started');

  return bot;
}

export async function stopTelegramBot(): Promise<void> {
  await bot?.stop();
}
