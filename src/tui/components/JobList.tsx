import { useState, useEffect, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { dashboardStore, type QueuedJob, type SubIssueInfo } from '../store.js';

function formatElapsed(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins === 0) return `${rem}s`;
  return `${mins}m${rem}s`;
}

function formatCountdown(until: number): string {
  const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m${secs}s`;
}

// Column widths for sub-issue rows
const COL = { marker: 4, identifier: 12, phase: 12, status: 10 } as const;

function SubIssueHeaderRow(): ReactElement {
  return (
    <Box width="100%">
      <Box width={COL.marker} flexShrink={0}><Text dimColor> </Text></Box>
      <Box width={COL.identifier} flexShrink={0}><Text bold dimColor>Issue</Text></Box>
      <Box width={COL.phase} flexShrink={0}><Text bold dimColor>Phase</Text></Box>
      <Box width={COL.status} flexShrink={0}><Text bold dimColor>Status</Text></Box>
      <Box flexGrow={1}><Text bold dimColor>Title</Text></Box>
    </Box>
  );
}

interface IssueBlockProps {
  identifier: string;
  title: string;
  subIssues: SubIssueInfo[];
  currentSubIssueIndex: number;
  isActive: boolean;
  phase?: string;
  startedAt?: number;
  state?: string;
  delayedUntil?: number;
}

function IssueBlock({ identifier, title, subIssues, currentSubIssueIndex, isActive, phase, startedAt, state, delayedUntil }: IssueBlockProps): ReactElement {
  const [, setTick] = useState(0);
  const isDelayed = state === 'delayed' && delayedUntil;

  useEffect(() => {
    if (!isActive && !isDelayed) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [isActive, isDelayed]);

  const stateColor = isActive ? 'green' : state === 'failed' ? 'red' : state === 'delayed' ? 'yellow' : 'gray';
  const statusLabel = isActive
    ? (startedAt ? formatElapsed(startedAt) : 'active')
    : isDelayed
      ? formatCountdown(delayedUntil!)
      : (state ?? 'waiting');

  const hasSubIssues = subIssues.length > 0;

  return (
    <Box flexDirection="column">
      {hasSubIssues ? (
        <>
          <SubIssueHeaderRow />
          {subIssues.map((sub, i) => {
            const isCurrent = i === currentSubIssueIndex;
            const isDone = i < currentSubIssueIndex;
            const isPending = i > currentSubIssueIndex;

            let subPhase = '-';
            let subStatus = 'pending';
            let subColor: string = 'gray';
            let marker = '  ';

            if (isDone) {
              subPhase = '-';
              subStatus = 'done';
              subColor = 'gray';
              marker = '✓ ';
            } else if (isCurrent && isActive) {
              subPhase = phase ?? '-';
              subStatus = startedAt ? formatElapsed(startedAt) : 'active';
              subColor = 'green';
              marker = '▶ ';
            } else if (isCurrent && !isActive) {
              subPhase = '-';
              subStatus = isDelayed ? formatCountdown(delayedUntil!) : (state ?? 'waiting');
              subColor = stateColor;
              marker = '▶ ';
            } else if (isPending) {
              subPhase = '-';
              subStatus = 'pending';
              subColor = 'gray';
              marker = '  ';
            }

            return (
              <Box key={sub.identifier} width="100%">
                <Box width={COL.marker} flexShrink={0}><Text color={subColor}>{marker}</Text></Box>
                <Box width={COL.identifier} flexShrink={0}><Text color={isDone ? 'gray' : undefined} dimColor={isDone || isPending} bold={isCurrent}>{sub.identifier}</Text></Box>
                <Box width={COL.phase} flexShrink={0}><Text color={subColor}>{subPhase}</Text></Box>
                <Box width={COL.status} flexShrink={0}><Text color={subColor}>{subStatus}</Text></Box>
                <Box flexGrow={1}><Text dimColor={isDone || isPending} bold={isCurrent}>{sub.title}</Text></Box>
              </Box>
            );
          })}
        </>
      ) : (
        /* No sub-issues — show the issue itself as the single row */
        <Box width="100%">
          <Box width={COL.marker} flexShrink={0}><Text color={stateColor}>{'▶ '}</Text></Box>
          <Box width={COL.identifier} flexShrink={0}><Text bold>{identifier}</Text></Box>
          <Box width={COL.phase} flexShrink={0}><Text color={stateColor}>{isActive ? (phase ?? '-') : '-'}</Text></Box>
          <Box width={COL.status} flexShrink={0}><Text color={stateColor}>{statusLabel}</Text></Box>
          <Box flexGrow={1}><Text>{title}</Text></Box>
        </Box>
      )}
    </Box>
  );
}

export function JobList(): ReactElement {
  const [activeJob, setActiveJob] = useState(dashboardStore.activeJob);
  const [queuedJobs, setQueuedJobs] = useState(dashboardStore.queuedJobs);

  useEffect(() => {
    const handler = () => {
      setActiveJob(dashboardStore.activeJob);
      setQueuedJobs([...dashboardStore.queuedJobs]);
    };
    dashboardStore.on('update', handler);
    return () => { dashboardStore.off('update', handler); };
  }, []);

  const hasJobs = activeJob != null || queuedJobs.length > 0;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      {!hasJobs && <Text dimColor>No jobs in queue</Text>}
      {activeJob && (
        <IssueBlock
          key={activeJob.jobId}
          identifier={activeJob.identifier}
          title={activeJob.title}
          subIssues={activeJob.subIssues}
          currentSubIssueIndex={activeJob.currentSubIssueIndex}
          isActive={true}
          phase={activeJob.phase}
          startedAt={activeJob.startedAt}
        />
      )}
      {queuedJobs.map((job) => (
        <IssueBlock
          key={job.jobId}
          identifier={job.identifier}
          title={job.title}
          subIssues={job.subIssues}
          currentSubIssueIndex={job.currentSubIssueIndex}
          isActive={false}
          state={job.state}
          delayedUntil={job.delayedUntil}
        />
      ))}
    </Box>
  );
}
