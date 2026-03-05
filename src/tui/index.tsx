import { render, type Instance } from 'ink';
import { App } from './App.js';
import { dashboardStore } from './store.js';

let inkInstance: Instance | null = null;

export function startTUI(): void {
  inkInstance = render(<App />);

  dashboardStore.on('command', (cmd: string) => {
    if (cmd === 'exit') {
      process.emit('SIGINT', 'SIGINT');
    }
  });
}

export function stopTUI(): void {
  inkInstance?.unmount();
  inkInstance = null;
}
