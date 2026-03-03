import { Bot, InlineKeyboard, type BotError } from 'grammy';
import { type Config } from '../config.js';
import { handleTelegramReply } from './bridge.js';
import { restartJob, restartJobFresh, killJob, listJobs } from '../queue/setup.js';
import { logger } from '../logger.js';

let bot: Bot;
let chatId: string;

export function getBot(): Bot {
  return bot;
}

export async function initTelegramBot(config: Config): Promise<Bot> {
  bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  chatId = config.TELEGRAM_CHAT_ID;

  // /status — list all jobs
  bot.command('status', async (ctx) => {
    if (String(ctx.chat.id) !== chatId) return;
    const jobs = await listJobs();
    if (jobs.length === 0) {
      await ctx.reply('No active jobs.');
      return;
    }
    const lines = jobs.map((j) => `\`${j.identifier}\` — ${j.state} (${j.phase})`);
    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /restart — restart latest failed/delayed job (resume phase)
  bot.command('restart', async (ctx) => {
    if (String(ctx.chat.id) !== chatId) return;
    const jobs = await listJobs();
    const target = jobs.find((j) => j.state === 'failed' || j.state === 'delayed');
    if (!target) {
      await ctx.reply('No failed or delayed jobs to restart.');
      return;
    }
    const ok = await restartJob(target.id);
    await ctx.reply(ok ? `Restarted \`${target.identifier}\` from ${target.phase} phase.` : 'Failed to restart.', { parse_mode: 'Markdown' });
  });

  // /retry — restart latest failed job from scratch
  bot.command('retry', async (ctx) => {
    if (String(ctx.chat.id) !== chatId) return;
    const jobs = await listJobs();
    const target = jobs.find((j) => j.state === 'failed' || j.state === 'delayed');
    if (!target) {
      await ctx.reply('No failed or delayed jobs to retry.');
      return;
    }
    const ok = await restartJobFresh(target.id);
    await ctx.reply(ok ? `Retrying \`${target.identifier}\` from scratch.` : 'Failed to retry.', { parse_mode: 'Markdown' });
  });

  // /kill — force-remove a job from the queue
  bot.command('kill', async (ctx) => {
    if (String(ctx.chat.id) !== chatId) return;
    const jobs = await listJobs();
    if (jobs.length === 0) {
      await ctx.reply('No jobs to kill.');
      return;
    }
    if (jobs.length === 1) {
      const ok = await killJob(jobs[0]!.id);
      await ctx.reply(ok ? `Killed \`${jobs[0]!.identifier}\`.` : 'Failed to kill.', { parse_mode: 'Markdown' });
      return;
    }
    // Multiple jobs — show inline buttons
    const keyboard = new InlineKeyboard();
    for (const j of jobs) {
      keyboard.text(`${j.identifier} (${j.phase})`, `kill_job:${j.id}`).row();
    }
    await ctx.reply('Which job to kill?', { reply_markup: keyboard });
  });

  // Handle callback queries (inline keyboard button presses)
  bot.on('callback_query:data', async (ctx) => {
    if (String(ctx.chat?.id) !== chatId) return;
    await ctx.answerCallbackQuery();

    const data = ctx.callbackQuery.data;

    // Handle kill buttons
    if (data.startsWith('kill_job:')) {
      const jobId = data.slice('kill_job:'.length);
      const ok = await killJob(jobId);
      await ctx.reply(ok ? 'Job killed.' : 'Could not kill — job not found.');
      return;
    }

    // Handle retry buttons from failure notifications
    if (data.startsWith('restart_job:')) {
      const jobId = data.slice('restart_job:'.length);
      const ok = await restartJob(jobId);
      await ctx.reply(ok ? 'Job restarted.' : 'Could not restart — job not found.');
      return;
    }
    if (data.startsWith('restart_fresh:')) {
      const jobId = data.slice('restart_fresh:'.length);
      const ok = await restartJobFresh(jobId);
      await ctx.reply(ok ? 'Job restarted from scratch.' : 'Could not restart — job not found.');
      return;
    }

    await handleTelegramReply(data);
  });

  // Handle all text messages as potential replies to pending questions
  bot.on('message:text', async (ctx) => {
    if (String(ctx.chat.id) !== chatId) return;
    await handleTelegramReply(ctx.message.text);
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
