import { type ReactElement, useState, useEffect } from 'react';
import { Box, useStdout } from 'ink';
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
  const contentHeight = height - 2; // reserve 2 rows for input + status bar (borders are inside the box heights)
  const logsHeight = Math.floor(contentHeight * 0.6);
  const jobsHeight = contentHeight - logsHeight;

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={logsHeight} flexDirection="column" overflowX="hidden" borderStyle="single" borderColor="gray">
        <LogStream height={logsHeight - 2} />
      </Box>
      <Box height={jobsHeight} flexDirection="column" overflowX="hidden" borderStyle="single" borderColor="gray">
        <JobList />
      </Box>
      <CommandInput />
      <StatusBar />
    </Box>
  );
}
