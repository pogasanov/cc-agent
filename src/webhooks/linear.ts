import crypto from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import { type Config } from '../config.js';
import { enqueueIssue } from '../queue/setup.js';
import { logger } from '../logger.js';

/** Verify Linear webhook HMAC-SHA256 signature */
function verifySignature(body: Buffer, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  const expected = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function registerLinearWebhook(server: FastifyInstance, config: Config): void {
  server.post('/webhooks/linear', async (request, reply) => {
    const signature = request.headers['linear-signature'] as string | undefined;
    if (!signature) {
      return reply.code(401).send({ error: 'Missing signature' });
    }

    const rawBody = request.rawBody;
    if (!rawBody || !verifySignature(rawBody, signature, config.LINEAR_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    // Respond 200 immediately — processing is async
    void reply.code(200).send({ ok: true });

    const payload = request.body as any;

    // Filter: issue updated, state changed to unstarted, assigned to our agent
    if (
      payload.action !== 'update' ||
      payload.type !== 'Issue' ||
      payload.data?.assigneeId !== config.LINEAR_AGENT_USER_ID
    ) {
      return;
    }

    // Check if state transitioned to the target state (Todo / unstarted)
    const stateChanged = payload.updatedFrom?.stateId !== undefined;
    if (!stateChanged) return;

    const issueId = payload.data.id as string;
    logger.info(`Linear webhook: enqueuing issue ${issueId}`);

    await enqueueIssue(issueId);
  });
}
