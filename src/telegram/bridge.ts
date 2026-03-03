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

/** Send a plain notification (no reply expected) */
export async function notify(message: string): Promise<void> {
  await getBot().api.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

/** Ask a question and wait for a free-text reply */
export async function askQuestion(question: string, jobId: string): Promise<string> {
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

  await getBot().api.sendMessage(chatId, `*Question:*\n${question}`, {
    parse_mode: 'Markdown',
  });

  // Wait for reply via Redis pub/sub
  return waitForReply(correlationId);
}

/** Send plan for approval with inline keyboard buttons */
export async function requestPlanApproval(
  plan: string,
  jobId: string,
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

  // Truncate plan if too long for Telegram (4096 char limit)
  const maxLen = 3800;
  const truncatedPlan = plan.length > maxLen ? plan.slice(0, maxLen) + '\n...(truncated)' : plan;

  await getBot().api.sendMessage(chatId, `*Plan for review:*\n\n${truncatedPlan}`, {
    parse_mode: 'Markdown',
    reply_markup: keyboard,
  });

  const reply = await waitForReply(correlationId);

  if (reply.startsWith('approve:')) return { decision: 'approved' };
  if (reply.startsWith('reject:')) return { decision: 'rejected' };
  if (reply.startsWith('changes:')) {
    // Ask for feedback text
    const feedback = await askQuestion('What changes would you like?', jobId);
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

  await getBot().api.sendMessage(
    chatId,
    `*Permission requested:*\n\`\`\`\n${command}\n\`\`\`\nAllow this command?`,
    { parse_mode: 'Markdown', reply_markup: keyboard },
  );

  const reply = await waitForReply(correlationId);
  return reply.startsWith('allow:');
}

/** Handle incoming Telegram messages/callback data */
export async function handleTelegramReply(data: string): Promise<void> {
  const redis = getRedis();

  // Check if the data contains a correlation ID (from inline keyboard)
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
function waitForReply(correlationId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const subscriber = getRedis().duplicate();
    const timeout = setTimeout(() => {
      subscriber.unsubscribe('cc-agent:replies');
      subscriber.quit();
      reject(new Error(`Telegram reply timeout for ${correlationId}`));
    }, 24 * 60 * 60 * 1000); // 24h

    subscriber.subscribe('cc-agent:replies').catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });

    subscriber.on('message', (_channel: string, message: string) => {
      const parsed = JSON.parse(message) as { correlationId: string; reply: string };
      if (parsed.correlationId === correlationId) {
        clearTimeout(timeout);
        subscriber.unsubscribe('cc-agent:replies');
        subscriber.quit();
        resolve(parsed.reply);
      }
    });
  });
}
