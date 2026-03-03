import { type Job } from 'bullmq';
import { type JobData } from '../types.js';
import {
  fetchIssue,
  markInProgress,
  markDone,
} from '../linear/client.js';
import { notify, notifyWithRetry, requestPlanApproval, askQuestion } from '../telegram/bridge.js';
import { runPlanPhase, runImplPhase } from '../claude/executor.js';
import {
  createBranch,
  commitAndPush,
  createPR,
  remoteBranchExists,
  checkCIStatus,
} from '../git/operations.js';
import { getRedis, getAbortSignal, clearAbort } from './setup.js';
import { logger } from '../logger.js';

const MAX_PLAN_RETRIES = 3;
const CI_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class JobKilledError extends Error {
  constructor() { super('Job killed'); this.name = 'JobKilledError'; }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new JobKilledError();
}

/** Main job processor — orchestrates the full lifecycle */
export async function processJob(job: Job<JobData>): Promise<void> {
  const data = job.data;
  const signal = getAbortSignal(job.id!);

  try {
    checkAbort(signal);

    // If this is a fresh job, fetch issue details first
    if (!data.issueIdentifier) {
      await setupJob(job);
    }

    checkAbort(signal);

    // Resume from the current phase
    switch (data.phase) {
      case 'plan':
        await planPhase(job);
        break;
      case 'approval':
        await approvalPhase(job);
        break;
      case 'implement':
        await implementPhase(job);
        break;
      case 'push':
        await pushPhase(job);
        break;
      case 'ci_wait':
        await ciWaitPhase(job);
        break;
      case 'mark_done':
        await markDonePhase(job);
        break;
    }
  } catch (err) {
    if (err instanceof JobKilledError) {
      logger.info(`Job ${job.id} was killed`);
      return; // Don't retry
    }
    logger.error(`Job ${job.id} failed in ${data.phase} phase: ${err}`);
    await notifyWithRetry(
      `Error in ${data.issueIdentifier || data.linearIssueId} (${data.phase}): ${err}`,
      job.id!,
    );
    throw err; // Let BullMQ handle the retry
  } finally {
    clearAbort(job.id!);
  }
}

async function setupJob(job: Job<JobData>): Promise<void> {
  const issue = await fetchIssue(job.data.linearIssueId);
  const sub = issue.subIssues[0];

  await job.updateData({
    ...job.data,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueDescription: issue.description ?? '',
    linearSubIssueId: sub?.id,
    subIssueDescription: sub?.description,
    branchName: `agent/${issue.identifier.toLowerCase()}-${slugify(issue.title)}`,
  });

  await markInProgress(job.data.linearIssueId);

  await notify(`Starting on *${issue.identifier}*: ${issue.title}`);
}

async function planPhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  logger.info(`[${data.issueIdentifier}] Plan phase (job ${job.id})`);

  // Create branch
  if (!(await remoteBranchExists(data.branchName))) {
    await createBranch(data.branchName);
  }

  const result = await runPlanPhase(
    data.issueDescription,
    data.subIssueDescription,
    job.id!,
    data.planSessionId,
  );

  await job.updateData({
    ...job.data,
    planSessionId: result.sessionId,
    planText: result.resultText,
    phase: 'approval',
  });

  checkAbort(getAbortSignal(job.id!));
  await approvalPhase(job);
}

async function approvalPhase(job: Job<JobData>, retryCount = 0): Promise<void> {
  const data = job.data;
  checkAbort(getAbortSignal(job.id!));
  logger.info(`[${data.issueIdentifier}] Approval phase (job ${job.id})`);

  const signal = getAbortSignal(job.id!);
  const approval = await requestPlanApproval(data.planText ?? '(no plan text)', job.id!, signal);
  checkAbort(getAbortSignal(job.id!));

  if (approval.decision === 'approved') {
    await job.updateData({ ...job.data, phase: 'implement' });
    await implementPhase(job);
    return;
  }

  if (approval.decision === 'rejected') {
    await notify(`Plan for ${data.issueIdentifier} was rejected. Stopping.`);
    return; // Job completes without further action
  }

  if (approval.decision === 'changes_requested') {
    if (retryCount >= MAX_PLAN_RETRIES) {
      await notify(`Max plan retries reached for ${data.issueIdentifier}. Stopping.`);
      return;
    }

    await notify(`Re-planning ${data.issueIdentifier} with feedback...`);

    // Re-run plan phase with feedback appended
    const feedbackPrompt = `${data.issueDescription}\n\n## Feedback on previous plan\n${approval.feedback}`;
    const result = await runPlanPhase(
      feedbackPrompt,
      data.subIssueDescription,
      job.id!,
      data.planSessionId,
    );

    await job.updateData({
      ...job.data,
      planSessionId: result.sessionId,
      planText: result.resultText,
      phase: 'approval',
    });

    checkAbort(getAbortSignal(job.id!));
    await approvalPhase(job, retryCount + 1);
  }
}

async function implementPhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  logger.info(`[${data.issueIdentifier}] Implementation phase (job ${job.id})`);

  const result = await runImplPhase(
    data.planSessionId!,
    job.id!,
    data.implSessionId,
  );

  await job.updateData({
    ...job.data,
    implSessionId: result.sessionId,
    phase: 'push',
  });

  checkAbort(getAbortSignal(job.id!));
  await pushPhase(job);
}

async function pushPhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  logger.info(`[${data.issueIdentifier}] Push phase (job ${job.id})`);

  const sha = await commitAndPush(data.branchName, data.issueIdentifier, data.issueTitle);

  const description = [
    data.issueDescription,
    '',
    `Linear: ${data.issueIdentifier}`,
  ].join('\n');

  const { prNumber, prUrl } = await createPR(
    data.branchName,
    data.issueIdentifier,
    data.issueTitle,
    description,
  );

  await job.updateData({
    ...job.data,
    headSha: sha,
    prNumber,
    phase: 'ci_wait',
  });

  await notify(`PR created for ${data.issueIdentifier}: ${prUrl}\nWaiting for CI...`);

  checkAbort(getAbortSignal(job.id!));
  await ciWaitPhase(job);
}

async function ciWaitPhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  logger.info(`[${data.issueIdentifier}] CI wait phase (job ${job.id})`);

  const redis = getRedis();
  const subscriber = redis.duplicate();

  try {
    const result = await Promise.race([
      waitForCIWebhook(subscriber, data.headSha!),
      waitTimeout(CI_TIMEOUT_MS),
    ]);

    if (result === 'timeout') {
      // Fallback: poll GitHub Checks API
      logger.info(`CI timeout for job ${job.id} — polling GitHub Checks API`);
      const status = await checkCIStatus(data.headSha!);

      if (status.conclusion === null) {
        // No CI configured — ask Telegram
        const answer = await askQuestion(
          `No CI detected for ${data.issueIdentifier}. Mark done anyway? (yes/no)`,
          job.id!,
        );
        if (answer.toLowerCase().startsWith('y')) {
          await job.updateData({ ...job.data, phase: 'mark_done' });
          await markDonePhase(job);
          return;
        }
        await notify(`${data.issueIdentifier} left in CI wait state.`);
        return;
      }

      if (status.conclusion !== 'success') {
        await notify(
          `CI failed for ${data.issueIdentifier}. Failed checks: ${status.failedChecks.join(', ')}`,
        );
        throw new Error(`CI failed: ${status.failedChecks.join(', ')}`);
      }
    } else if (result === 'failure') {
      await notify(`CI failed for ${data.issueIdentifier}.`);
      throw new Error('CI check_suite failed');
    }

    // CI passed
    await job.updateData({ ...job.data, phase: 'mark_done' });
    await markDonePhase(job);
  } finally {
    await subscriber.quit();
  }
}

async function markDonePhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  logger.info(`[${data.issueIdentifier}] Marking done (job ${job.id})`);

  const targetIssueId = data.linearSubIssueId ?? data.linearIssueId;
  await markDone(targetIssueId);

  await notify(
    `${data.issueIdentifier} completed! Branch: \`${data.branchName}\``,
  );
}

// --- Helpers ---

function waitForCIWebhook(
  subscriber: ReturnType<typeof getRedis>,
  headSha: string,
): Promise<'success' | 'failure'> {
  return new Promise((resolve, reject) => {
    subscriber.subscribe('cc-agent:ci-results').catch((err) => {
      reject(err);
    });

    subscriber.on('message', (_channel: string, message: string) => {
      const parsed = JSON.parse(message) as { headSha: string; conclusion: string };
      if (parsed.headSha === headSha) {
        subscriber.unsubscribe('cc-agent:ci-results');
        resolve(parsed.conclusion === 'success' ? 'success' : 'failure');
      }
    });
  });
}

function waitTimeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
