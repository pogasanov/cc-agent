import { useState, useEffect, type ReactElement } from 'react';
import { Box, Text, useStdout } from 'ink';
import { dashboardStore, type LogEntry } from '../store.js';

function LogLine({ entry }: { entry: LogEntry }): ReactElement {
  const time = entry.timestamp.toLocaleTimeString();
  const color = entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'yellow' : undefined;

  return (
    <Text wrap="truncate" color={color} dimColor={entry.level === 'info'}>
      {time} {entry.message}
    </Text>
  );
}

export function LogStream(): ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>(dashboardStore.logs);
  const { stdout } = useStdout();
  const height = (stdout?.rows ?? 24) - 4; // reserve for header/borders

  useEffect(() => {
    const handler = () => {
      setLogs([...dashboardStore.logs]);
    };
    dashboardStore.on('update', handler);
    return () => { dashboardStore.off('update', handler); };
  }, []);

  const visible = logs.slice(-height);

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold underline>Logs</Text>
      {visible.map((entry, i) => (
        <LogLine key={i} entry={entry} />
      ))}
    </Box>
  );
}
