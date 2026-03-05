import { useState, useEffect, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { dashboardStore, type LogEntry } from '../store.js';

const COL_TIME = 20;

function LogLine({ entry }: { entry: LogEntry }): ReactElement {
  const time = entry.timestamp.toLocaleTimeString();
  const color = entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'yellow' : undefined;

  return (
    <Box>
      <Box width={COL_TIME} flexShrink={0}>
        <Text color={color} dimColor={entry.level === 'info'}>{time}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap" color={color} dimColor={entry.level === 'info'}>{entry.message}</Text>
      </Box>
    </Box>
  );
}

export function LogStream(): ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>(dashboardStore.logs);
  useEffect(() => {
    const handler = () => {
      setLogs([...dashboardStore.logs]);
    };
    dashboardStore.on('update', handler);
    return () => { dashboardStore.off('update', handler); };
  }, []);

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box>
        <Box width={COL_TIME} flexShrink={0}><Text bold dimColor>Time</Text></Box>
        <Box flexGrow={1}><Text bold dimColor>Message</Text></Box>
      </Box>
      {logs.map((entry, i) => (
        <LogLine key={i} entry={entry} />
      ))}
    </Box>
  );
}
