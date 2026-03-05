import { type ReactElement, useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { JobList } from './components/JobList.js';
import { LogStream } from './components/LogStream.js';
import { CommandInput } from './components/CommandInput.js';
import { StatusBar } from './components/StatusBar.js';

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    width: stdout?.columns ?? 80,
    height: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setSize({ width: stdout.columns, height: stdout.rows });
    };
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  return size;
}

export function App(): ReactElement {
  const { width, height } = useTerminalSize();
  const contentHeight = height - 2; // reserve 2 rows for input + status bar
  const leftWidth = Math.floor(width / 2);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="row" height={contentHeight}>
        <Box width={leftWidth} flexDirection="column" overflowX="hidden">
          <JobList />
        </Box>
        <Box width={1} flexDirection="column">
          {Array.from({ length: contentHeight }, (_, i) => (
            <Text key={i}>│</Text>
          ))}
        </Box>
        <Box width={width - leftWidth - 1} flexDirection="column" overflowX="hidden">
          <LogStream />
        </Box>
      </Box>
      <CommandInput />
      <StatusBar />
    </Box>
  );
}
