import { InlineKeyboard } from 'grammy';
import { getBot } from './bot.js';
import { type Config } from '../config.js';
import { type ApprovalResult } from '../types.js';
import { getRedis } from '../queue/setup.js';
import { logger } from '../logger.js';
import crypto from 'node:crypto';

let chatId: string;

export function initBridge(config: Config): void {
  chatId = config.TELEGRAM_CHAT_ID;
}

/** Split text into chunks that fit within Telegram's message size limit */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

/** Send a long message split across multiple Telegram messages */
export async function sendLong(message: string): Promise<void> {
  const chunks = splitMessage(message, 3800);
  for (const chunk of chunks) {
    await safeSend(chunk);
  }
}

/** Send a message with Markdown, falling back to plain text if parsing fails */
async function safeSend(
  text: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await getBot().api.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("can't parse entities")) {
      // Strip Markdown and retry as plain text
      const { parse_mode: _, ...rest } = { parse_mode: 'Markdown', ...extra };
      await getBot().api.sendMessage(chatId, text, rest);
    } else {
      throw err;
    }
  }
}

/** Send a plain notification (no reply expected) */
export async function notify(message: string): Promise<void> {
  await safeSend(message);
}

/** Send a failure notification with Retry / Restart buttons */
export async function notifyWithRetry(message: string, jobId: string): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text('Retry (resume)', `restart_job:${jobId}`)
    .text('Retry (fresh)', `restart_fresh:${jobId}`);

  await safeSend(message, { reply_markup: keyboard });
}

/** Ask a question and wait for a free-text reply */
export async function askQuestion(question: string, jobId: string, options: string[] = [], signal?: AbortSignal): Promise<string> {
  const correlationId = crypto.randomUUID();

  // Store pending question in Redis
  const redis = getRedis();
  await redis.set(
    `cc-agent:pending:${correlationId}`,
    JSON.stringify({ correlationId, jobId, question, timestamp: Date.now() }),
    'EX',
    86400, // 24h TTL
  );

  // Track the latest pending correlation ID for this chat
  await redis.set('cc-agent:latest-pending', correlationId, 'EX', 86400);

  const sendOptions: Record<string, unknown> = {};

  // Render options as inline keyboard buttons if provided
  if (options.length > 0) {
    const keyboard = new InlineKeyboard();
    for (const opt of options) {
      keyboard.text(opt, `answer:${correlationId}:${opt}`);
    }
    sendOptions.reply_markup = keyboard;
  }

  await safeSend(`*Question:*\n${question}`, sendOptions);

  // Wait for reply via Redis pub/sub
  return waitForReply(correlationId, signal);
}

/** Send plan for approval with inline keyboard buttons */
export async function requestPlanApproval(
  plan: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<ApprovalResult> {
  const correlationId = crypto.randomUUID();

  const redis = getRedis();
  await redis.set(
    `cc-agent:pending:${correlationId}`,
    JSON.stringify({ correlationId, jobId, question: 'plan_approval', timestamp: Date.now() }),
    'EX',
    86400,
  );
  await redis.set('cc-agent:latest-pending', correlationId, 'EX', 86400);

  const keyboard = new InlineKeyboard()
    .text('Approve', `approve:${correlationId}`)
    .text('Reject', `reject:${correlationId}`)
    .row()
    .text('Request Changes', `changes:${correlationId}`);

  // Split plan into chunks that fit Telegram's 4096 char limit
  const chunks = splitMessage(plan, 3800);
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const prefix = isFirst ? '*Plan for review:*\n\n' : '';
    const extra: Record<string, unknown> = isLast ? { reply_markup: keyboard } : {};
    await safeSend(`${prefix}${chunks[i]}`, extra);
  }

  const reply = await waitForReply(correlationId, signal);

  if (reply.startsWith('approve:')) return { decision: 'approved' };
  if (reply.startsWith('reject:')) return { decision: 'rejected' };
  if (reply.startsWith('changes:')) {
    // Ask for feedback text
    const feedback = await askQuestion('What changes would you like?', jobId, [], signal);
    return { decision: 'changes_requested', feedback };
  }

  // Treat free-text replies as change requests
  return { decision: 'changes_requested', feedback: reply };
}

/** Forward a dangerous command for Telegram approval */
export async function requestPermission(
  command: string,
  jobId: string,
): Promise<boolean> {
  const correlationId = crypto.randomUUID();

  const redis = getRedis();
  await redis.set(
    `cc-agent:pending:${correlationId}`,
    JSON.stringify({ correlationId, jobId, question: 'permission', timestamp: Date.now() }),
    'EX',
    86400,
  );
  await redis.set('cc-agent:latest-pending', correlationId, 'EX', 86400);

  const keyboard = new InlineKeyboard()
    .text('Allow', `allow:${correlationId}`)
    .text('Deny', `deny:${correlationId}`);

  await safeSend(
    `*Permission requested:*\n\`\`\`\n${command}\n\`\`\`\nAllow this command?`,
    { reply_markup: keyboard },
  );

  const reply = await waitForReply(correlationId);
  return reply.startsWith('allow:');
}

/** Handle incoming Telegram messages/callback data */
export async function handleTelegramReply(data: string): Promise<void> {
  const redis = getRedis();

  // Handle answer buttons: "answer:<correlationId>:<selected option>"
  if (data.startsWith('answer:')) {
    const firstColon = data.indexOf(':');
    const secondColon = data.indexOf(':', firstColon + 1);
    if (secondColon !== -1) {
      const correlationId = data.slice(firstColon + 1, secondColon);
      const answer = data.slice(secondColon + 1);
      const pending = await redis.get(`cc-agent:pending:${correlationId}`);
      if (pending) {
        await redis.del(`cc-agent:pending:${correlationId}`);
        await redis.publish('cc-agent:replies', JSON.stringify({ correlationId, reply: answer }));
        return;
      }
    }
  }

  // Check if the data contains a correlation ID (from inline keyboard)
  // Format: "action:correlationId" (approve, reject, changes, allow, deny)
  const parts = data.split(':');
  if (parts.length === 2) {
    const correlationId = parts[1]!;
    const pending = await redis.get(`cc-agent:pending:${correlationId}`);
    if (pending) {
      await redis.del(`cc-agent:pending:${correlationId}`);
      await redis.publish('cc-agent:replies', JSON.stringify({ correlationId, reply: data }));
      return;
    }
  }

  // Free-text reply — resolve the latest pending question
  const latestId = await redis.get('cc-agent:latest-pending');
  if (latestId) {
    await redis.del(`cc-agent:pending:${latestId}`);
    await redis.del('cc-agent:latest-pending');
    await redis.publish('cc-agent:replies', JSON.stringify({ correlationId: latestId, reply: data }));
  }
}

/** Wait for a reply on a specific correlation ID via Redis pub/sub */
function waitForReply(correlationId: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const subscriber = getRedis().duplicate();

    const cleanup = () => {
      subscriber.unsubscribe('cc-agent:replies');
      subscriber.quit();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Telegram reply timeout for ${correlationId}`));
    }, 24 * 60 * 60 * 1000); // 24h

    // Abort support — if the job is killed, reject immediately
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        cleanup();
        reject(new Error('Job killed'));
        return;
      }
      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error('Job killed'));
      }, { once: true });
    }

    subscriber.subscribe('cc-agent:replies').catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });

    subscriber.on('message', (_channel: string, message: string) => {
      const parsed = JSON.parse(message) as { correlationId: string; reply: string };
      if (parsed.correlationId === correlationId) {
        clearTimeout(timeout);
        cleanup();
        resolve(parsed.reply);
      }
    });
  });
}
