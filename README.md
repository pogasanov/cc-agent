# cc-agent

Autonomous daemon that bridges Linear project management with Claude Code execution, using Telegram as the human-in-the-loop interface.

## How it works

```
Linear webhook → Fastify server → BullMQ job → Claude Code plans → Telegram approval
→ Claude Code implements → Git push → GitHub webhook (CI done) → Mark done in Linear
```

1. **Detection**: Linear webhook fires when an issue is assigned to the agent user and moved to Todo
2. **Planning**: Claude Code explores the codebase and generates an implementation plan (read-only)
3. **Approval**: Plan is sent to Telegram for human review (approve / reject / request changes)
4. **Implementation**: Claude Code implements the approved plan (with dangerous command gating via Telegram)
5. **Push**: Changes are committed, pushed, and a PR is created
6. **CI**: Waits for GitHub check suite to pass (webhook-driven, with 30min polling fallback)
7. **Done**: Marks the Linear issue as Done

## Prerequisites

- Node.js 20+
- Redis (for BullMQ job queue)
- Claude Code CLI installed and authenticated (`claude` command working)
- A Telegram bot (create via [@BotFather](https://t.me/BotFather))
- Linear API key + webhook configured
- GitHub token with repo access

## Setup

### 1. Clone and install

```bash
git clone <repo-url> cc-agent
cd cc-agent
npm install
```

### 2. Start Redis

```bash
docker compose up -d
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 4. Configure webhooks

#### Linear webhook

1. Go to Linear Settings → API → Webhooks
2. Create webhook pointing to `https://<your-domain>/webhooks/linear`
3. Select "Issues" events
4. Copy the signing secret to `LINEAR_WEBHOOK_SECRET`

#### GitHub webhook

1. Go to repo Settings → Webhooks → Add webhook
2. Payload URL: `https://<your-domain>/webhooks/github`
3. Content type: `application/json`
4. Secret: set and copy to `GITHUB_WEBHOOK_SECRET`
5. Events: select "Check suites"

### 5. Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

### 6. systemd (optional)

```bash
sudo cp cc-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cc-agent
```

## Environment Variables

| Variable | Description |
|---|---|
| `LINEAR_API_KEY` | Linear API key (`lin_api_...`) |
| `LINEAR_AGENT_USER_ID` | UUID of the Linear user the daemon watches |
| `LINEAR_TEAM_ID` | Linear team UUID |
| `LINEAR_WEBHOOK_SECRET` | HMAC secret for verifying Linear webhooks |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Telegram chat ID of the human operator |
| `GITHUB_TOKEN` | GitHub PAT with repo access |
| `GITHUB_OWNER` | GitHub org or username |
| `GITHUB_REPO` | Repository name |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for verifying GitHub webhooks |
| `REPO_PATH` | Absolute path to the pre-cloned repository |
| `REDIS_URL` | Redis connection URL (default: `redis://localhost:6379`) |
| `WEBHOOK_PORT` | HTTP server port (default: `3000`) |
| `WEBHOOK_BASE_URL` | Public URL for webhook endpoints |

## Architecture

```
src/
├── index.ts              # Entry point: starts all services
├── config.ts             # Zod-validated env config
├── types.ts              # Shared TypeScript interfaces
├── logger.ts             # Winston logger
├── orchestrator.ts       # Re-exports job processor
├── webhooks/
│   ├── server.ts         # Fastify HTTP server
│   ├── linear.ts         # Linear webhook handler (HMAC verify + enqueue)
│   └── github.ts         # GitHub webhook handler (check_suite events)
├── linear/
│   └── client.ts         # Linear API: fetch issues, update status
├── telegram/
│   ├── bot.ts            # grammy bot initialization
│   └── bridge.ts         # Telegram ↔ job communication (questions, approvals, permissions)
├── claude/
│   └── executor.ts       # Agent SDK wrapper: plan + implementation phases
├── git/
│   └── operations.ts     # Branch, commit, push, PR creation, CI polling
└── queue/
    ├── setup.ts          # BullMQ queue + worker + Redis connection
    └── processor.ts      # Job processor state machine (plan → approve → impl → push → ci → done)
```

## Resume on restart

BullMQ persists all jobs in Redis. If the daemon crashes:

- **Active Claude sessions**: resumed via stored `session_id`
- **Pending approvals**: plan re-sent to Telegram
- **CI waits**: continue waiting for webhook (or poll after 30min)
- **Stalled jobs**: automatically retried by BullMQ after 30s

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm run typecheck    # Type check without emitting
npm run build        # Production build with tsup
```
