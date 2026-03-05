import { type Job } from 'bullmq';
import { type JobData } from '../types.js';
import {
  fetchIssue,
  markInProgress,
  markDone,
} from '../linear/client.js';
import { notify, notifyWithRetry, requestPlanApproval, askQuestion, sendLong } from '../telegram/bridge.js';
import { runPlanPhase, runImplPhase, runFixPhase } from '../claude/executor.js';
import { runValidation, formatValidationErrors } from '../validate/runner.js';
import {
  createBranch,
  checkoutAndPull,
  commitAndPush,
  createPR,
  remoteBranchExists,
  checkCIStatus,
  markPRReady,
} from '../git/operations.js';
import { getAbortSignal, clearAbort, isShuttingDown, getRepoPath, signalJobCompletion } from './setup.js';
import { logger } from '../logger.js';
import { dashboardStore } from '../tui/store.js';

const MAX_PLAN_RETRIES = 3;
const MAX_VALIDATE_RETRIES = 3;
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

    // Show job in TUI immediately, before setupJob blocks on Telegram
    dashboardStore.setActiveJob({
      jobId: job.id!,
      identifier: data.issueIdentifier || data.linearIssueId,
      title: data.issueTitle || '',
      phase: 'setup',
      startedAt: Date.now(),
      subIssues: (data.subIssues ?? []).map((s) => ({ identifier: s.identifier, title: s.title })),
      currentSubIssueIndex: data.currentSubIssueIndex ?? 0,
    });

    checkAbort(signal);

    // If this is a fresh job, fetch issue details first
    if (!data.issueIdentifier) {
      await setupJob(job);
    }

    // Update with fetched details (identifier, title, subIssues may have changed)
    dashboardStore.setActiveJob({
      jobId: job.id!,
      identifier: job.data.issueIdentifier || job.data.linearIssueId,
      title: job.data.issueTitle,
      phase: job.data.phase,
      startedAt: Date.now(),
      subIssues: (job.data.subIssues ?? []).map((s) => ({ identifier: s.identifier, title: s.title })),
      currentSubIssueIndex: job.data.currentSubIssueIndex ?? 0,
    });

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
      case 'validate':
        await validatePhase(job);
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
      if (isShuttingDown()) {
        logger.info(`Job ${job.id} interrupted by shutdown — will resume on restart`);
        await job.updateData({ ...job.data, failReason: 'shutdown' });
        throw err; // Let BullMQ mark as failed so recoverStalledJobs picks it up
      }
      logger.info(`Job ${job.id} was killed`);
      await job.updateData({ ...job.data, failReason: 'killed' });
      return; // User-initiated kill — don't retry
    }
    const currentData = job.data;
    logger.error(`Job ${job.id} failed in ${currentData.phase} phase: ${err}`);
    await job.updateData({ ...job.data, failReason: 'error' });
    await notifyWithRetry(
      `Error in ${currentData.issueIdentifier || currentData.linearIssueId} (${currentData.phase}): ${err}`,
      job.id!,
    );
    throw err;
  } finally {
    dashboardStore.clearActiveJob();
    clearAbort(job.id!);
    signalJobCompletion(job.id!);
  }
}

async function setupJob(job: Job<JobData>): Promise<void> {
  const issue = await fetchIssue(job.data.linearIssueId);

  await job.updateData({
    ...job.data,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueDescription: issue.description ?? '',
    subIssues: issue.subIssues
      .map((s) => ({
        id: s.id,
        identifier: s.identifier,
        title: s.title,
        description: s.description,
      }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })),
    currentSubIssueIndex: 0,
    branchName: `agent/${issue.identifier.toLowerCase()}-${slugify(issue.title)}`,
  });

  await markInProgress(job.data.linearIssueId);

  const subCount = issue.subIssues.length;
  await notify(
    `Starting on *${issue.identifier}*: ${issue.title}` +
      (subCount > 0 ? ` (${subCount} sub-issues)` : ''),
  );

  const answer = await askQuestion(
    `*${issue.identifier}*: Auto accept all or manual?`,
    job.id!,
    ['Auto', 'Manual'],
  );
  const autoAccept = answer.toLowerCase().startsWith('auto') || answer.toLowerCase() === 'auto';
  await job.updateData({ ...job.data, autoAccept });
}

/** Get the task description to feed to Claude — sub-issue text only, or main issue if no sub-issues */
function getCurrentTaskDescription(data: JobData): string {
  if (data.subIssues.length === 0) {
    return data.issueDescription;
  }
  const sub = data.subIssues[data.currentSubIssueIndex]!;
  const parts = [`# ${sub.title}`];
  if (sub.description) parts.push(sub.description);
  return parts.join('\n\n');
}

async function planPhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  const taskLabel = currentTaskLabel(data);
  logger.info(`[${taskLabel}] Plan phase (job ${job.id})`);

  // Ask for confirmation before starting a sub-issue (skip if autoAccept)
  const currentSub = data.subIssues[data.currentSubIssueIndex];
  if (currentSub) {
    if (data.autoAccept) {
      await notify(`Auto-starting sub-issue *${currentSub.identifier}* — ${currentSub.title}`);
    } else {
      const answer = await askQuestion(
        `Start sub-issue *${currentSub.identifier}* — ${currentSub.title}?`,
        job.id!,
        ['Yes', 'No'],
      );
      if (!answer.toLowerCase().startsWith('y')) {
        await notify(`Paused before ${currentSub.identifier}. Use /restart to resume later.`);
        return;
      }
    }
    await markInProgress(currentSub.id);
  }

  // Switch to branch — create from main if first sub-issue, otherwise checkout and pull
  if (!(await remoteBranchExists(data.branchName))) {
    await createBranch(data.branchName);
  } else {
    await checkoutAndPull(data.branchName);
  }

  const taskDescription = getCurrentTaskDescription(data);
  await notify(`Prompt for *${taskLabel}*:\n\`\`\`\n${taskDescription}\n\`\`\``);
  const onUsage = (i: number, o: number, c: number) => dashboardStore.addTokens(i, o, c);
  const result = await runPlanPhase(taskDescription, job.id!, data.planSessionId, onUsage);

  await job.updateData({
    ...job.data,
    planSessionId: result.sessionId,
    planText: result.resultText,
    phase: 'approval',
  });
  dashboardStore.updatePhase('approval');

  checkAbort(getAbortSignal(job.id!));
  await approvalPhase(job);
}

async function approvalPhase(job: Job<JobData>, retryCount = 0): Promise<void> {
  const data = job.data;
  checkAbort(getAbortSignal(job.id!));
  logger.info(`[${data.issueIdentifier}] Approval phase (job ${job.id})`);

  if (data.autoAccept) {
    await sendLong(`*Plan (auto-approved):*\n\n${data.planText ?? '(no plan text)'}`);
    await job.updateData({ ...job.data, phase: 'implement' });
    dashboardStore.updatePhase('implement');
    await implementPhase(job);
    return;
  }

  const signal = getAbortSignal(job.id!);
  const approval = await requestPlanApproval(data.planText ?? '(no plan text)', job.id!, signal);
  checkAbort(getAbortSignal(job.id!));

  if (approval.decision === 'approved') {
    await job.updateData({ ...job.data, phase: 'implement' });
    dashboardStore.updatePhase('implement');
    await implementPhase(job);
    return;
  }

  if (approval.decision === 'rejected') {
    await notify(`Plan for ${data.issueIdentifier} was rejected. Stopping.`);
    return; // Job completes without further action
  }

  if (approval.decision === 'changes_requested') {
    const taskLabel = currentTaskLabel(data);
    if (retryCount >= MAX_PLAN_RETRIES) {
      await notify(`Max plan retries reached for ${taskLabel}. Stopping.`);
      return;
    }

    await notify(`Re-planning ${taskLabel} with feedback...`);

    // Re-run plan phase with feedback appended
    const taskDescription = getCurrentTaskDescription(data);
    const feedbackPrompt = `${taskDescription}\n\n## Feedback on previous plan\n${approval.feedback}`;
    const onUsage = (i: number, o: number, c: number) => dashboardStore.addTokens(i, o, c);
    const result = await runPlanPhase(feedbackPrompt, job.id!, data.planSessionId, onUsage);

    await job.updateData({
      ...job.data,
      planSessionId: result.sessionId,
      planText: result.resultText,
      phase: 'approval',
    });
    dashboardStore.updatePhase('approval');

    checkAbort(getAbortSignal(job.id!));
    await approvalPhase(job, retryCount + 1);
  }
}

async function implementPhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  logger.info(`[${data.issueIdentifier}] Implementation phase (job ${job.id})`);

  const onUsage = (i: number, o: number, c: number) => dashboardStore.addTokens(i, o, c);
  const result = await runImplPhase(
    data.planSessionId!,
    job.id!,
    data.implSessionId,
    onUsage,
  );

  await job.updateData({
    ...job.data,
    implSessionId: result.sessionId,
    validateAttempt: 0,
    phase: 'validate',
  });
  dashboardStore.updatePhase('validate');

  checkAbort(getAbortSignal(job.id!));
  await validatePhase(job);
}

async function validatePhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  const taskLabel = currentTaskLabel(data);
  const attempt = data.validateAttempt ?? 0;
  logger.info(`[${taskLabel}] Validate phase attempt ${attempt + 1} (job ${job.id})`);

  await notify(`Running validation for *${taskLabel}* (lint, build, tests)...`);

  const report = await runValidation(getRepoPath());

  if (report.passed) {
    logger.info(`[${taskLabel}] All validation checks passed`);
    await notify(`Validation passed for *${taskLabel}*`);

    await job.updateData({ ...job.data, phase: 'push' });
    dashboardStore.updatePhase('push');
    checkAbort(getAbortSignal(job.id!));
    await pushPhase(job);
    return;
  }

  // Validation failed
  const errorSummary = formatValidationErrors(report);
  const failedLabels = report.results.filter((r) => !r.passed).map((r) => r.label).join(', ');
  await notify(`Validation failed for *${taskLabel}* (${failedLabels}). Attempt ${attempt + 1}/${MAX_VALIDATE_RETRIES}.`);

  if (attempt >= MAX_VALIDATE_RETRIES - 1) {
    await notify(`Max validation retries reached for *${taskLabel}*. Stopping.`);
    throw new Error(`Validation failed after ${MAX_VALIDATE_RETRIES} attempts: ${failedLabels}`);
  }

  // Send errors to Claude to fix
  logger.info(`[${taskLabel}] Sending validation errors to Claude for fixing`);
  const onUsage = (i: number, o: number, c: number) => dashboardStore.addTokens(i, o, c);
  const fixResult = await runFixPhase(data.implSessionId!, errorSummary, job.id!, onUsage);

  await job.updateData({
    ...job.data,
    implSessionId: fixResult.sessionId,
    validateAttempt: attempt + 1,
    phase: 'validate',
  });
  dashboardStore.updatePhase('validate');

  checkAbort(getAbortSignal(job.id!));
  await validatePhase(job);
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

  const isLastSubIssue = data.subIssues.length === 0 ||
    data.currentSubIssueIndex >= data.subIssues.length - 1;

  if (isLastSubIssue) {
    // Mark current sub-issue done before marking PR ready
    const currentSub = data.subIssues[data.currentSubIssueIndex];
    const targetIssueId = currentSub?.id ?? data.linearIssueId;
    await markDone(targetIssueId);

    await markPRReady(prNumber);

    await job.updateData({
      ...job.data,
      headSha: sha,
      prNumber,
      phase: 'ci_wait',
    });
    dashboardStore.updatePhase('ci_wait');

    await notify(`PR created for ${data.issueIdentifier}: ${prUrl}\nWaiting for CI...`);

    checkAbort(getAbortSignal(job.id!));
    await ciWaitPhase(job);
  } else {
    await job.updateData({
      ...job.data,
      headSha: sha,
      prNumber,
      phase: 'mark_done',
    });
    dashboardStore.updatePhase('mark_done');

    await notify(`Pushed ${currentTaskLabel(data)} to ${prUrl}`);

    checkAbort(getAbortSignal(job.id!));
    await markDonePhase(job);
  }
}

async function ciWaitPhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  logger.info(`[${data.issueIdentifier}] CI wait phase (job ${job.id})`);

  const POLL_INTERVAL_MS = 30_000;
  const startTime = Date.now();

  // Initial delay to let deployment checks register
  await sleep(POLL_INTERVAL_MS, getAbortSignal(job.id!));

  while (Date.now() - startTime < CI_TIMEOUT_MS) {
    checkAbort(getAbortSignal(job.id!));

    const status = await checkCIStatus(data.headSha!);

    if (status.conclusion === null) {
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

    if (status.conclusion === 'success') {
      logger.info(`[${data.issueIdentifier}] All CI checks passed`);
      await job.updateData({ ...job.data, phase: 'mark_done' });
      await markDonePhase(job);
      return;
    }

    if (status.conclusion === 'failure') {
      await notify(
        `CI failed for ${data.issueIdentifier}. Failed checks: ${status.failedChecks.join(', ')}`,
      );
      throw new Error(`CI failed: ${status.failedChecks.join(', ')}`);
    }

    // Still pending — wait and poll again
    logger.info(`[${data.issueIdentifier}] CI checks still in progress, polling again in 30s`);
    await sleep(POLL_INTERVAL_MS, getAbortSignal(job.id!));
  }

  // Timeout
  throw new Error(`CI timed out after ${CI_TIMEOUT_MS / 60_000} minutes for ${data.issueIdentifier}`);
}

async function markDonePhase(job: Job<JobData>): Promise<void> {
  const data = job.data;
  const taskLabel = currentTaskLabel(data);
  logger.info(`[${taskLabel}] Marking done (job ${job.id})`);

  // Mark the current sub-issue (or main issue) as done
  const currentSub = data.subIssues[data.currentSubIssueIndex];
  const targetIssueId = currentSub?.id ?? data.linearIssueId;
  await markDone(targetIssueId);

  const nextIndex = data.currentSubIssueIndex + 1;
  if (nextIndex < data.subIssues.length) {
    await notify(`Completed *${taskLabel}*. Moving to next sub-issue...`);

    await job.updateData({
      ...job.data,
      currentSubIssueIndex: nextIndex,
      planSessionId: undefined,
      implSessionId: undefined,
      planText: undefined,
      prNumber: undefined,
      headSha: undefined,
      phase: 'plan',
    });

    dashboardStore.updateSubIssueIndex(nextIndex);
    dashboardStore.updatePhase('plan');
    checkAbort(getAbortSignal(job.id!));
    await planPhase(job);
  } else {
    // All sub-issues done (or no sub-issues) — mark main issue done too if we had sub-issues
    if (data.subIssues.length > 0) {
      await markDone(data.linearIssueId);
    }
    await notify(`${data.issueIdentifier} fully completed! Branch: \`${data.branchName}\``);
  }
}

// --- Helpers ---

/** Human-readable label for the current task (sub-issue identifier or main issue) */
function currentTaskLabel(data: JobData): string {
  const sub = data.subIssues[data.currentSubIssueIndex];
  return sub?.identifier ?? data.issueIdentifier;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new JobKilledError()); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new JobKilledError()); }, { once: true });
  });
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
