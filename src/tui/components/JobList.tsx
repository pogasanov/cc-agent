import { useState, useEffect, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { dashboardStore, type ActiveJob, type QueuedJob } from '../store.js';

function formatElapsed(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins === 0) return `${rem}s`;
  return `${mins}m${rem}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// Column widths
const COL = { id: 3, identifier: 12, phase: 12, status: 10 } as const;

function HeaderRow(): ReactElement {
  return (
    <Box>
      <Box width={COL.id}><Text bold dimColor>#</Text></Box>
      <Box width={COL.identifier}><Text bold dimColor>Issue</Text></Box>
      <Box width={COL.phase}><Text bold dimColor>Phase</Text></Box>
      <Box width={COL.status}><Text bold dimColor>Status</Text></Box>
      <Box flexGrow={1}><Text bold dimColor>Title</Text></Box>
    </Box>
  );
}

function ActiveRow({ job, index }: { job: ActiveJob; index: number }): ReactElement {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <Box>
        <Box width={COL.id}><Text bold color="green">{index}</Text></Box>
        <Box width={COL.identifier}><Text bold>{job.identifier}</Text></Box>
        <Box width={COL.phase}><Text color="green">{job.phase}</Text></Box>
        <Box width={COL.status}><Text color="green">{formatElapsed(job.startedAt)}</Text></Box>
        <Box flexGrow={1}><Text>{job.title}</Text></Box>
      </Box>
      <Box paddingLeft={COL.id}>
        <Text dimColor>IN:{job.inputTokens.toLocaleString()} OUT:{job.outputTokens.toLocaleString()} {formatCost(job.costUSD)}</Text>
      </Box>
    </>
  );
}

function formatCountdown(until: number): string {
  const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m${secs}s`;
}

function QueuedRow({ job, index }: { job: QueuedJob; index: number }): ReactElement {
  const [, setTick] = useState(0);
  const isDelayed = job.state === 'delayed' && job.delayedUntil;

  useEffect(() => {
    if (!isDelayed) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [isDelayed]);

  const stateColor = job.state === 'failed' ? 'red' : job.state === 'delayed' ? 'yellow' : 'gray';
  const statusText = isDelayed ? `${formatCountdown(job.delayedUntil!)}` : job.state;

  return (
    <Box>
      <Box width={COL.id}><Text dimColor>{index}</Text></Box>
      <Box width={COL.identifier}><Text dimColor>{job.identifier}</Text></Box>
      <Box width={COL.phase}><Text dimColor>-</Text></Box>
      <Box width={COL.status}><Text color={stateColor}>{statusText}</Text></Box>
      <Box flexGrow={1}><Text dimColor>{job.title}</Text></Box>
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

  let nextIndex = 1;

  return (
    <Box flexDirection="column" paddingX={1}>
      <HeaderRow />
      {activeJob ? (
        <ActiveRow job={activeJob} index={nextIndex++} />
      ) : (
        <Text dimColor>No active job</Text>
      )}
      {queuedJobs.map((job) => (
        <QueuedRow key={job.jobId} job={job} index={nextIndex++} />
      ))}
    </Box>
  );
}
