import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { type Config } from '../config.js';
import { registerLinearWebhook } from './linear.js';
import { registerGithubWebhook } from './github.js';
import { logger } from '../logger.js';

// Extend FastifyRequest to carry the raw body for HMAC verification
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function createServer(config: Config): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });

  // Capture raw body for HMAC signature verification
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, JSON.parse(body.toString()));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Health check
  server.get('/health', async () => ({ status: 'ok' }));

  // Register webhook routes
  registerLinearWebhook(server, config);
  registerGithubWebhook(server, config);

  await server.listen({ port: config.WEBHOOK_PORT, host: '0.0.0.0' });
  logger.info(`Webhook server listening on port ${config.WEBHOOK_PORT}`);

  return server;
}
