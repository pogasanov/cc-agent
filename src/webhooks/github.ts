import crypto from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import { type Config } from '../config.js';
import { resolveCIWait } from '../queue/setup.js';
import { logger } from '../logger.js';

/** Verify GitHub webhook HMAC-SHA256 signature */
function verifySignature(body: Buffer, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  const expected = `sha256=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function registerGithubWebhook(server: FastifyInstance, config: Config): void {
  server.post('/webhooks/github', async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    if (!signature) {
      return reply.code(401).send({ error: 'Missing signature' });
    }

    const rawBody = request.rawBody;
    if (!rawBody || !verifySignature(rawBody, signature, config.GITHUB_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    void reply.code(200).send({ ok: true });

    const event = request.headers['x-github-event'] as string;
    if (event !== 'check_suite') return;

    const payload = request.body as any;
    if (payload.action !== 'completed') return;

    const headSha = payload.check_suite?.head_sha as string | undefined;
    const conclusion = payload.check_suite?.conclusion as string | undefined;

    if (!headSha || !conclusion) return;

    logger.info(`GitHub webhook: check_suite completed (${headSha} → ${conclusion})`);

    await resolveCIWait(headSha, conclusion);
  });
}
