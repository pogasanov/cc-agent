import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { type Config } from '../config.js';
import { type JobData } from '../types.js';
import { processJob } from './processor.js';
import { logger } from '../logger.js';

let queue: Queue<JobData>;
let worker: Worker<JobData>;
let redis: Redis;

export function getRedis(): Redis {
  return redis;
}

export function getQueue(): Queue<JobData> {
  return queue;
}

export function initQueue(config: Config): void {
  const redisUrl = new URL(config.REDIS_URL);

  const connection = {
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

  worker = new Worker<JobData>('cc-agent-jobs', processJob, {
    connection,
    concurrency: 1, // Process one issue at a time
    stalledInterval: 30_000,
  });

  worker.on('failed', (job: Job<JobData> | undefined, err: Error) => {
    logger.error(`Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('completed', (job: Job<JobData>) => {
    logger.info(`Job ${job.id} completed`);
  });

  worker.on('stalled', (jobId: string) => {
    logger.warn(`Job ${jobId} stalled — will be retried`);
  });

  logger.info('BullMQ queue and worker initialized');
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
  }

  await queue.add(
    'execute-issue',
    {
      linearIssueId: issueId,
      issueIdentifier: '',
      issueTitle: '',
      issueDescription: '',
      branchName: '',
      phase: 'plan',
    },
    { jobId: issueId },
  );

  logger.info(`Enqueued issue ${issueId}`);
}

/** Resolve a CI wait — called by GitHub webhook handler */
export async function resolveCIWait(headSha: string, conclusion: string): Promise<void> {
  // Publish CI result to Redis pub/sub so the waiting job processor can pick it up
  await redis.publish(
    'cc-agent:ci-results',
    JSON.stringify({ headSha, conclusion }),
  );
}

export async function closeQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  await redis?.quit();
}
