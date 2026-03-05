import { type ReactElement } from 'react';
import { Box, Text, useStdout } from 'ink';
import { JobList } from './components/JobList.js';
import { LogStream } from './components/LogStream.js';
import { CommandInput } from './components/CommandInput.js';

export function App(): ReactElement {
  const { stdout } = useStdout();
  const height = stdout?.rows ?? 24;
  const width = stdout?.columns ?? 80;
  const contentHeight = height - 1; // reserve 1 row for input
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
    </Box>
  );
}
