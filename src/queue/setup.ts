import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { type Config } from '../config.js';
import { type JobData } from '../types.js';
import { processJob } from './processor.js';
import { logger } from '../logger.js';
import { dashboardStore } from '../tui/store.js';

let queue: Queue<JobData>;
let worker: Worker<JobData>;
let redis: Redis;
let repoPath: string;

/** AbortControllers for active jobs — kill signals the controller */
const activeAborts = new Map<string, AbortController>();
/** Resolvers for awaiting processor completion after kill */
const completionResolvers = new Map<string, () => void>();
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function getAbortSignal(jobId: string): AbortSignal {
  if (shuttingDown) {
    return AbortSignal.abort();
  }
  let ctrl = activeAborts.get(jobId);
  if (!ctrl) {
    ctrl = new AbortController();
    activeAborts.set(jobId, ctrl);
  }
  return ctrl.signal;
}

export function clearAbort(jobId: string): void {
  activeAborts.delete(jobId);
}

/** Called from processor's finally block to unblock any pending killJob() await */
export function signalJobCompletion(jobId: string): void {
  const resolve = completionResolvers.get(jobId);
  if (resolve) {
    resolve();
    completionResolvers.delete(jobId);
  }
}

export function getRedis(): Redis {
  return redis;
}

export function getRepoPath(): string {
  return repoPath;
}

export function getQueue(): Queue<JobData> {
  return queue;
}

let connection: { host: string; port: number };

/** Initialize Redis + queue only (no worker yet) */
export function initQueue(config: Config): void {
  repoPath = config.REPO_PATH;
  const redisUrl = new URL(config.REDIS_URL);

  connection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port) || 6379,
  };

  redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
  });

  queue = new Queue<JobData>('cc-agent-jobs', {
    connection,
    defaultJobOptions: {
      removeOnComplete: { age: 86400 }, // 24h
      removeOnFail: { age: 86400 },
      attempts: 1,
    },
  });

  logger.info('BullMQ queue initialized');
}

/** Start the worker — call this AFTER recovery */
export function startWorker(): void {
  worker = new Worker<JobData>('cc-agent-jobs', processJob, {
    connection,
    concurrency: 1,
    stalledInterval: 30_000,
    lockDuration: 300_000,
  });

  worker.on('active', () => { refreshQueueInStore(); });

  worker.on('failed', (job: Job<JobData> | undefined, err: Error) => {
    logger.error(`Job ${job?.id} failed: ${err.message}`);
    refreshQueueInStore();
  });

  worker.on('completed', (job: Job<JobData>) => {
    logger.info(`Job ${job.id} completed`);
    refreshQueueInStore();
  });

  worker.on('stalled', (jobId: string) => {
    logger.warn(`Job ${jobId} stalled — will be retried`);
    refreshQueueInStore();
  });

  logger.info('BullMQ worker started');
}

/**
 * Recover jobs that were active when the daemon last crashed.
 * Selective recovery based on failReason:
 * - active jobs: always recover (process crashed)
 * - failed jobs: only if failReason is 'shutdown' or undefined (crash)
 * - delayed jobs: recover (cleanup from old retry backoff)
 */
export async function recoverStalledJobs(): Promise<void> {
  const active = await queue.getJobs(['active']);
  const failed = await queue.getJobs(['failed']);
  const delayed = await queue.getJobs(['delayed']);

  const shouldRecover = (job: Job<JobData>, state: string): boolean => {
    if (state === 'active' || state === 'delayed') return true;
    // For failed jobs, only recover shutdown-interrupted or crash-stalled (no failReason)
    const reason = job.data.failReason;
    return reason === 'shutdown' || reason === undefined;
  };

  for (const job of [...active, ...failed, ...delayed]) {
    if (!job) continue;
    const state = await job.getState();
    const id = job.data.issueIdentifier || job.data.linearIssueId;

    if (!shouldRecover(job, state)) {
      logger.info(`Skipping recovery of job ${job.id} (${id}, state=${state}, failReason=${job.data.failReason})`);
      continue;
    }

    logger.info(`Recovering stuck job ${job.id} (${id}, phase=${job.data.phase}, state=${state})`);

    const data = { ...job.data, failReason: undefined };
    const jobId = job.id!;

    // Force-remove the lock and job directly from Redis
    await redis.del(`bull:cc-agent-jobs:${jobId}:lock`);
    try {
      await job.remove();
    } catch {
      // If remove still fails, delete the Redis keys manually
      await redis.del(`bull:cc-agent-jobs:${jobId}`);
      await redis.lrem('bull:cc-agent-jobs:active', 0, jobId);
      await redis.lrem('bull:cc-agent-jobs:failed', 0, jobId);
      await redis.zrem('bull:cc-agent-jobs:delayed', jobId);
    }

    await queue.add('execute-issue', data, { jobId });
    logger.info(`Re-enqueued job ${jobId} (${id}) in phase ${data.phase}`);
  }
}

/** Enqueue a new issue for processing */
export async function enqueueIssue(issueId: string): Promise<void> {
  // Use issueId as the job ID for deduplication
  const existing = await queue.getJob(issueId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'active' || state === 'waiting' || state === 'delayed') {
      logger.info(`Job for issue ${issueId} already exists (${state}), skipping`);
      return;
    }
    // Remove stale completed/failed job so we can re-use the jobId
    try { await existing.remove(); } catch { /* already gone */ }
  }

  await queue.add(
    'execute-issue',
    {
      linearIssueId: issueId,
      issueIdentifier: '',
      issueTitle: '',
      issueDescription: '',
      subIssues: [],
      currentSubIssueIndex: 0,
      branchName: '',
      phase: 'plan',
    },
    { jobId: issueId },
  );

  logger.info(`Enqueued issue ${issueId}`);
  refreshQueueInStore();
}

/** Resolve a CI wait — called by GitHub webhook handler */
export async function resolveCIWait(headSha: string, conclusion: string): Promise<void> {
  // Publish CI result to Redis pub/sub so the waiting job processor can pick it up
  await redis.publish(
    'cc-agent:ci-results',
    JSON.stringify({ headSha, conclusion }),
  );
}

/** Force-kill a job — abort in-flight execution and wait for processor to exit */
export async function killJob(jobId: string): Promise<boolean> {
  const ctrl = activeAborts.get(jobId);
  if (ctrl) {
    // Register a completion promise so we can await processor exit
    const completionPromise = new Promise<void>((resolve) => {
      completionResolvers.set(jobId, resolve);
    });
    ctrl.abort();
    // Wait for processor to finish (max 60s safety timeout)
    await Promise.race([
      completionPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 60_000)),
    ]);
    completionResolvers.delete(jobId);
    logger.info(`Killed job ${jobId}`);
    return true;
  }

  // Job is not actively processing — safe to force-remove from Redis
  const job = await queue.getJob(jobId);
  if (!job) return false;

  await redis.del(`bull:cc-agent-jobs:${jobId}:lock`);
  try {
    await job.remove();
  } catch {
    await redis.del(`bull:cc-agent-jobs:${jobId}`);
    await redis.lrem('bull:cc-agent-jobs:active', 0, jobId);
    await redis.lrem('bull:cc-agent-jobs:waiting', 0, jobId);
    await redis.lrem('bull:cc-agent-jobs:delayed', 0, jobId);
    await redis.lrem('bull:cc-agent-jobs:failed', 0, jobId);
  }

  logger.info(`Killed job ${jobId}`);
  return true;
}

/** Restart a job — kill if active, remove, and re-enqueue from its current phase */
export async function restartJob(jobId: string): Promise<boolean> {
  // If actively processing, kill first and wait for processor to exit
  if (activeAborts.has(jobId)) {
    await killJob(jobId);
  }

  const job = await queue.getJob(jobId);
  if (!job) return false;

  const data = { ...job.data, failReason: undefined };
  await job.remove();
  await queue.add('execute-issue', data, { jobId });
  logger.info(`Restarted job ${jobId} in phase ${data.phase}`);
  return true;
}

/** Restart a job from scratch (reset to plan phase) */
export async function restartJobFresh(jobId: string): Promise<boolean> {
  // If actively processing, kill first and wait for processor to exit
  if (activeAborts.has(jobId)) {
    await killJob(jobId);
  }

  const job = await queue.getJob(jobId);
  if (!job) return false;

  const data = { ...job.data, phase: 'plan' as const, planSessionId: undefined, implSessionId: undefined, planText: undefined, failReason: undefined };
  await job.remove();
  await queue.add('execute-issue', data, { jobId });
  logger.info(`Restarted job ${jobId} from scratch`);
  return true;
}

/** Get all jobs for display */
export async function listJobs(): Promise<Array<{ id: string; state: string; identifier: string; title: string; phase: string; delayedUntil?: number; subIssues: Array<{ identifier: string; title: string }>; currentSubIssueIndex: number }>> {
  const jobs = await queue.getJobs(['active', 'waiting', 'delayed', 'failed']);
  const result = [];
  for (const job of jobs) {
    if (!job) continue;
    const state = await job.getState();
    result.push({
      id: job.id!,
      state,
      identifier: job.data.issueIdentifier || job.data.linearIssueId,
      title: job.data.issueTitle ?? '',
      phase: job.data.phase,
      delayedUntil: state === 'delayed' ? job.timestamp + job.delay : undefined,
      subIssues: (job.data.subIssues ?? []).map((s) => ({ identifier: s.identifier, title: s.title })),
      currentSubIssueIndex: job.data.currentSubIssueIndex ?? 0,
    });
  }
  return result;
}

async function refreshQueueInStore(): Promise<void> {
  try {
    const jobs = await listJobs();
    dashboardStore.refreshQueue(
      jobs
        .filter((j) => j.state !== 'active')
        .map((j) => ({ jobId: j.id, identifier: j.identifier, title: j.title, state: j.state, delayedUntil: j.delayedUntil, subIssues: j.subIssues, currentSubIssueIndex: j.currentSubIssueIndex })),
    );
  } catch {
    // Ignore errors during refresh — queue may not be ready yet
  }
}

export async function closeQueue(): Promise<void> {
  // Set global shutdown flag so any new getAbortSignal calls return aborted
  shuttingDown = true;

  // Abort all active jobs so processors stop immediately
  for (const [, ctrl] of activeAborts) {
    ctrl.abort();
  }

  await worker?.close();
  await queue?.close();
  await redis?.quit();
}
