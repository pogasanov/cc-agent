import { Queue, Worker, type Job } from 'bullmq';
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
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30_000,
      },
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
 * Clears stale locks directly in Redis, then re-enqueues.
 */
export async function recoverStalledJobs(): Promise<void> {
  const active = await queue.getJobs(['active']);
  const failed = await queue.getJobs(['failed']);
  const delayed = await queue.getJobs(['delayed']);

  for (const job of [...active, ...failed, ...delayed]) {
    if (!job) continue;
    const id = job.data.issueIdentifier || job.data.linearIssueId;
    logger.info(`Recovering stuck job ${job.id} (${id}, phase=${job.data.phase})`);

    const data = { ...job.data };
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

/** Force-kill a job — abort in-flight execution and remove from queue */
export async function killJob(jobId: string): Promise<boolean> {
  // Abort the in-flight processor if running
  const ctrl = activeAborts.get(jobId);
  if (ctrl) {
    ctrl.abort();
    activeAborts.delete(jobId);
    // Don't force-remove from Redis — let the processor return naturally
    // so BullMQ can clean up its lock manager timer without errors.
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

/** Restart a job — remove it and re-enqueue from its current phase */
export async function restartJob(jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  if (!job) return false;

  const data = { ...job.data };
  await job.remove();
  await queue.add('execute-issue', data, { jobId });
  logger.info(`Restarted job ${jobId} in phase ${data.phase}`);
  return true;
}

/** Restart a job from scratch (reset to plan phase) */
export async function restartJobFresh(jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  if (!job) return false;

  const data = { ...job.data, phase: 'plan' as const, planSessionId: undefined, implSessionId: undefined, planText: undefined };
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
