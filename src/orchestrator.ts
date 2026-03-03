// The orchestrator logic is implemented directly in src/queue/processor.ts
// as the BullMQ job processor. This file re-exports for convenience.

export { processJob } from './queue/processor.js';
