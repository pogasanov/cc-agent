import { useState, type ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';
import { dashboardStore } from '../store.js';

export function CommandInput(): ReactElement {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.return) {
      if (value.trim()) {
        dashboardStore.emit('command', value.trim());
        setValue('');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box>
      <Text bold color="cyan">&gt; </Text>
      <Text>{value}</Text>
      <Text color="gray">█</Text>
    </Box>
  );
}
