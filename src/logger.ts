import winston from 'winston';
import TransportStream from 'winston-transport';
import { dashboardStore } from './tui/store.js';

class TUITransport extends TransportStream {
  log(info: any, callback: () => void): void {
    const message = typeof info.message === 'string' ? info.message : JSON.stringify(info.message);
    dashboardStore.appendLog(info.level, message);
    callback();
  }
}

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  ],
});

export function switchToTUI(): void {
  logger.remove(logger.transports.find((t) => t instanceof winston.transports.Console)!);
  logger.add(new TUITransport());
}
