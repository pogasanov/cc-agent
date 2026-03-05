import { useState, useEffect, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { dashboardStore } from '../store.js';

function formatTokens(n: number): string {
  return n.toString().padStart(9);
}

export function StatusBar(): ReactElement {
  const [activeJob, setActiveJob] = useState(dashboardStore.activeJob);

  useEffect(() => {
    const handler = () => setActiveJob(dashboardStore.activeJob);
    dashboardStore.on('update', handler);
    return () => { dashboardStore.off('update', handler); };
  }, []);

  if (!activeJob) {
    return <Box><Text dimColor>No active job</Text></Box>;
  }

  return (
    <Box>
      <Text dimColor>IN:</Text><Text>{formatTokens(activeJob.inputTokens)}</Text>
      <Text>  </Text>
      <Text dimColor>OUT:</Text><Text>{formatTokens(activeJob.outputTokens)}</Text>
    </Box>
  );
}
