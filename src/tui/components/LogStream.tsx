import { useState, useEffect, useRef, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
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

export function LogStream({ height }: { height: number }): ReactElement {
  const [logs, setLogs] = useState<LogEntry[]>(dashboardStore.logs);
  const [scrollOffset, setScrollOffset] = useState(0);
  const autoScroll = useRef(true);
  const viewportHeight = Math.max(1, height - 1); // -1 for header row

  useEffect(() => {
    const handler = () => {
      setLogs([...dashboardStore.logs]);
    };
    dashboardStore.on('update', handler);
    return () => { dashboardStore.off('update', handler); };
  }, []);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll.current) {
      setScrollOffset(Math.max(0, logs.length - viewportHeight));
    }
  }, [logs.length, viewportHeight]);

  useInput((_input, key) => {
    if (key.upArrow || _input === 'k') {
      setScrollOffset((prev) => {
        const next = Math.max(0, prev - 1);
        autoScroll.current = false;
        return next;
      });
    } else if (key.downArrow || _input === 'j') {
      setScrollOffset((prev) => {
        const maxOffset = Math.max(0, logs.length - viewportHeight);
        const next = Math.min(maxOffset, prev + 1);
        if (next >= maxOffset) autoScroll.current = true;
        return next;
      });
    } else if (_input === 'G') {
      // Jump to bottom
      autoScroll.current = true;
      setScrollOffset(Math.max(0, logs.length - viewportHeight));
    } else if (_input === 'g') {
      // Jump to top
      autoScroll.current = false;
      setScrollOffset(0);
    }
  });

  const visible = logs.slice(scrollOffset, scrollOffset + viewportHeight);
  const atBottom = scrollOffset >= logs.length - viewportHeight;

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Box>
        <Box width={COL_TIME} flexShrink={0}><Text bold dimColor>Time</Text></Box>
        <Box flexGrow={1}><Text bold dimColor>Message</Text></Box>
        <Text dimColor>{atBottom ? '' : `[${logs.length - scrollOffset - viewportHeight}↓]`}</Text>
      </Box>
      {visible.map((entry, i) => (
        <LogLine key={scrollOffset + i} entry={entry} />
      ))}
    </Box>
  );
}
