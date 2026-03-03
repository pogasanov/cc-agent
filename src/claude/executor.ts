import { query } from '@anthropic-ai/claude-agent-sdk';
import { type Config } from '../config.js';
import { askQuestion, requestPermission, notify } from '../telegram/bridge.js';
import { logger } from '../logger.js';

let repoPath: string;

export function initExecutor(config: Config): void {
  repoPath = config.REPO_PATH;
}

/** Dangerous patterns that require Telegram approval */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /truncate/i,
  /format\s+\//i,
];

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

/** Extract question text and options from AskUserQuestion tool input */
function extractQuestion(input: Record<string, unknown>): { text: string; options: string[] } {
  const questions = (input as any).questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const q = questions[0];
    const text = q.question ?? q.header ?? '';
    const options: string[] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (o.label) options.push(o.label);
      }
    }
    return { text, options };
  }
  if (typeof input.question === 'string') return { text: input.question, options: [] };
  return { text: JSON.stringify(input), options: [] };
}

/** Max number of consecutive rate-limit retries before giving up */
const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Parse a retry-after duration from a rate limit error message.
 * Looks for patterns like "try again in 1m30s", "retry after 90 seconds",
 * "try again in 45s", or an ISO timestamp.
 * Returns milliseconds to wait, or a default of 60s if unparseable.
 */
function parseRetryAfter(errorMessage: string): number {
  const DEFAULT_WAIT_MS = 60_000;

  // Match "in Xm Ys" or "in Xs" or "in Xm"
  const durationMatch = errorMessage.match(
    /(?:in|after)\s+(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\s*(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?/i,
  );
  if (durationMatch && (durationMatch[1] || durationMatch[2])) {
    const mins = parseInt(durationMatch[1] || '0', 10);
    const secs = parseInt(durationMatch[2] || '0', 10);
    return (mins * 60 + secs) * 1000 || DEFAULT_WAIT_MS;
  }

  // Match "after <N> seconds"
  const secsMatch = errorMessage.match(/(?:in|after)\s+(\d+)\s+seconds/i);
  if (secsMatch) {
    return parseInt(secsMatch[1]!, 10) * 1000;
  }

  // Match ISO timestamp
  const isoMatch = errorMessage.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
  if (isoMatch) {
    const resumeAt = new Date(isoMatch[1]!).getTime();
    const wait = resumeAt - Date.now();
    return wait > 0 ? wait : DEFAULT_WAIT_MS;
  }

  return DEFAULT_WAIT_MS;
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /rate.?limit|token.?limit|too many|quota|capacity|overloaded/i.test(msg);
}

function formatWait(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m${rem}s` : `${mins}m`;
}

export interface ClaudeResult {
  sessionId: string;
  resultText: string;
}

/** Run the plan phase — read-only exploration + plan generation */
export async function runPlanPhase(
  taskDescription: string,
  jobId: string,
  resumeSessionId?: string,
): Promise<ClaudeResult> {
  const prompt = buildPlanPrompt(taskDescription);

  return withRateLimitRetry('plan', resumeSessionId, (resume) => {
    return runClaudeSession({
      prompt,
      permissionMode: 'plan',
      resume,
      suppressResultNotification: true,
      canUseTool: async (toolName, input) => {
        if (toolName === 'AskUserQuestion') {
          const { text: question, options } = extractQuestion(input);
          const answer = await askQuestion(question, jobId, options);
          return { behavior: 'deny' as const, message: `User answered: ${answer}` };
        }
        // Only allow read-only tools during plan phase
        const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent'];
        if (!readOnlyTools.includes(toolName)) {
          return { behavior: 'deny' as const, message: 'Write tools are not allowed during planning. Only explore and produce a plan.' };
        }
        return { behavior: 'allow' as const, updatedInput: input };
      },
    });
  });
}

/** Run the implementation phase — resume from plan session */
export async function runImplPhase(
  planSessionId: string,
  jobId: string,
  resumeSessionId?: string,
): Promise<ClaudeResult> {
  const effectiveSessionId = resumeSessionId ?? planSessionId;

  return withRateLimitRetry('impl', effectiveSessionId, (resume) => {
    return runClaudeSession({
      prompt: `The plan has been approved. Proceed with implementation.\n\n## Instructions\n${STANDING_INSTRUCTIONS}`,
      permissionMode: 'default',
      resume,
      canUseTool: async (toolName, input) => {
        if (['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit'].includes(toolName)) {
          return { behavior: 'allow' as const, updatedInput: input };
        }

        if (toolName === 'Bash') {
          const command = (input as any).command ?? '';
          if (isDangerousCommand(command)) {
            const allowed = await requestPermission(command, jobId);
            if (!allowed) {
              return { behavior: 'deny' as const, message: 'Command denied by operator' };
            }
          }
          return { behavior: 'allow' as const, updatedInput: input };
        }

        if (toolName === 'AskUserQuestion') {
          const { text: question, options } = extractQuestion(input);
          const answer = await askQuestion(question, jobId, options);
          return { behavior: 'deny' as const, message: `User answered: ${answer}` };
        }

        return { behavior: 'allow' as const, updatedInput: input };
      },
    });
  });
}

/** Run a fix phase — resume the impl session with validation errors to fix */
export async function runFixPhase(
  implSessionId: string,
  validationErrors: string,
  jobId: string,
): Promise<ClaudeResult> {
  return withRateLimitRetry('fix', implSessionId, (resume) => {
    return runClaudeSession({
      prompt: `The following validation checks failed after your implementation. Please fix all errors:\n\n${validationErrors}\n\n## Instructions\n${STANDING_INSTRUCTIONS}`,
      permissionMode: 'default',
      resume,
      canUseTool: async (toolName, input) => {
        if (['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit'].includes(toolName)) {
          return { behavior: 'allow' as const, updatedInput: input };
        }

        if (toolName === 'Bash') {
          const command = (input as any).command ?? '';
          if (isDangerousCommand(command)) {
            const allowed = await requestPermission(command, jobId);
            if (!allowed) {
              return { behavior: 'deny' as const, message: 'Command denied by operator' };
            }
          }
          return { behavior: 'allow' as const, updatedInput: input };
        }

        if (toolName === 'AskUserQuestion') {
          const { text: question, options } = extractQuestion(input);
          const answer = await askQuestion(question, jobId, options);
          return { behavior: 'deny' as const, message: `User answered: ${answer}` };
        }

        return { behavior: 'allow' as const, updatedInput: input };
      },
    });
  });
}

// --- Internal helpers ---

interface SessionOptions {
  prompt: string;
  permissionMode: string;
  resume?: string;
  /** When true, the final assistant text (= resultText) is not sent via notify(), since the caller will send it separately (e.g. with approval buttons) */
  suppressResultNotification?: boolean;
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<any>;
}

/** Run a single Claude Code session and collect session ID + result */
async function runClaudeSession(opts: SessionOptions): Promise<ClaudeResult> {
  let sessionId = '';
  let resultText = '';
  // When suppressResultNotification is set, buffer the last assistant text so we
  // can skip notifying it (it will be sent separately, e.g. with approval buttons).
  // All previous texts are flushed (notified) as new ones arrive.
  let pendingText: string | null = null;

  const q = query({
    prompt: opts.prompt,
    options: {
      permissionMode: opts.permissionMode as any,
      cwd: repoPath,
      ...(opts.resume ? { resume: opts.resume } : {}),
      canUseTool: opts.canUseTool as any,
    },
  });

  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
      logger.info(`Claude session started: ${sessionId}`);
    }

    if (message.type === 'assistant') {
      const content = (message as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            logger.info(`[claude] ${block.text}`);
            if (opts.suppressResultNotification) {
              // Flush the previously buffered text before buffering the new one
              if (pendingText !== null) {
                notify(pendingText).catch(() => {});
              }
              pendingText = block.text;
            } else {
              notify(block.text).catch(() => {});
            }
          } else if (block.type === 'tool_use') {
            logger.info(`[claude] tool: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
          }
        }
      }
    }

    if (message.type === 'user' && (message as any).parent_tool_use_id) {
      const toolResult = (message as any).tool_use_result;
      if (toolResult !== undefined) {
        const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
        logger.info(`[claude] tool result: ${resultStr.slice(0, 500)}`);
      }
    }

    if (message.type === 'result') {
      resultText = (message as any).result;
      logger.info(`[claude] result: ${resultText.slice(0, 500)}`);
    }
  }

  // If suppressing and the buffered text is the final result, drop it
  // (the caller will send it with buttons). Otherwise flush it.
  if (pendingText !== null && pendingText !== resultText) {
    notify(pendingText).catch(() => {});
  }

  return { sessionId: sessionId || opts.resume || '', resultText };
}

/**
 * Wrap a Claude session runner with rate-limit retry logic.
 * On rate/token limit errors: notify Telegram, sleep until the retry-after
 * time, then resume the session.
 */
async function withRateLimitRetry(
  phase: string,
  initialResume: string | undefined,
  run: (resume: string | undefined) => Promise<ClaudeResult>,
): Promise<ClaudeResult> {
  let lastSessionId = initialResume;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      return await run(lastSessionId);
    } catch (err) {
      if (!isRateLimitError(err) || attempt === MAX_RATE_LIMIT_RETRIES) {
        throw err;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      const waitMs = parseRetryAfter(errMsg);

      logger.warn(
        `Rate/token limit hit during ${phase} (attempt ${attempt}), waiting ${formatWait(waitMs)}: ${errMsg}`,
      );

      await notify(
        `Rate limit hit during *${phase}* phase. Pausing for ${formatWait(waitMs)} before resuming...`,
      );

      await new Promise((resolve) => setTimeout(resolve, waitMs));

      logger.info(`Resuming ${phase} after rate limit pause (attempt ${attempt + 1})`);
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error(`Exceeded max rate limit retries for ${phase} phase`);
}

const STANDING_INSTRUCTIONS = `Do not run E2E tests - they will be executed in CI`;

function buildPlanPrompt(taskDescription: string): string {
  return `You are working on a task from our project management system.

## Task
${taskDescription}

## Instructions
${STANDING_INSTRUCTIONS}

Explore the codebase and form a detailed implementation plan. Describe:
1. Which files need to be created or modified
2. What changes are needed in each file
3. Any dependencies or considerations
4. The order of implementation steps`;
}
