import { EventEmitter } from 'events';

export interface ActiveJob {
  jobId: string;
  identifier: string;
  title: string;
  phase: string;
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface QueuedJob {
  jobId: string;
  identifier: string;
  title: string;
  state: string;
  delayedUntil?: number;
}

export interface LogEntry {
  timestamp: Date;
  level: string;
  message: string;
}

const MAX_LOGS = 500;

class DashboardStore extends EventEmitter {
  activeJob: ActiveJob | null = null;
  queuedJobs: QueuedJob[] = [];
  logs: LogEntry[] = [];

  setActiveJob(job: Omit<ActiveJob, 'inputTokens' | 'outputTokens' | 'costUSD'>): void {
    this.activeJob = { ...job, inputTokens: 0, outputTokens: 0, costUSD: 0 };
    this.emit('update');
  }

  updatePhase(phase: string): void {
    if (this.activeJob) {
      this.activeJob.phase = phase;
      this.emit('update');
    }
  }

  addTokens(inputTokens: number, outputTokens: number, costUSD: number): void {
    if (this.activeJob) {
      this.activeJob.inputTokens += inputTokens;
      this.activeJob.outputTokens += outputTokens;
      this.activeJob.costUSD += costUSD;
      this.emit('update');
    }
  }

  refreshQueue(jobs: QueuedJob[]): void {
    this.queuedJobs = jobs;
    this.emit('update');
  }

  appendLog(level: string, message: string): void {
    this.logs.push({ timestamp: new Date(), level, message });
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(-MAX_LOGS);
    }
    this.emit('update');
  }

  clearActiveJob(): void {
    this.activeJob = null;
    this.emit('update');
  }
}

export const dashboardStore = new DashboardStore();
