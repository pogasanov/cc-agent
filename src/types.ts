/** Phases of a job's lifecycle */
export type JobPhase =
  | 'plan'
  | 'approval'
  | 'implement'
  | 'validate'
  | 'push'
  | 'ci_wait'
  | 'mark_done';

/** Minimal sub-issue info stored on the job */
export interface SubIssueRef {
  id: string;
  identifier: string;
  title: string;
  description: string | undefined;
}

/** Data stored in each BullMQ job */
export interface JobData {
  linearIssueId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string;
  subIssues: SubIssueRef[];
  currentSubIssueIndex: number;
  branchName: string;
  planSessionId?: string;
  implSessionId?: string;
  planText?: string;
  prNumber?: number;
  headSha?: string;
  validateAttempt?: number;
  autoAccept?: boolean;
  phase: JobPhase;
  failReason?: 'shutdown' | 'error' | 'killed';
}

/** Result of plan approval via Telegram */
export type ApprovalResult =
  | { decision: 'approved' }
  | { decision: 'rejected' }
  | { decision: 'changes_requested'; feedback: string };

/** Pending question awaiting a Telegram reply */
export interface PendingQuestion {
  correlationId: string;
  jobId: string;
  question: string;
  options?: string[];
  timestamp: number;
}

/** Linear issue as fetched from the API */
export interface LinearIssueData {
  id: string;
  identifier: string;
  title: string;
  description: string | undefined;
  branchName: string;
  subIssues: Array<{
    id: string;
    identifier: string;
    title: string;
    description: string | undefined;
  }>;
}

/** GitHub check suite status */
export interface CIStatus {
  conclusion: 'success' | 'failure' | 'pending' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | null;
  failedChecks: string[];
}
