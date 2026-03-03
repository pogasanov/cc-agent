# cc-agent

Autonomous coding agent that picks up Linear issues, plans and implements them with Claude Code, and ships pull requests — with a human in the loop via Telegram. Assign a ticket, approve the plan in your chat, and come back to a ready PR.

## How it works

```
                          ┌─────────────────────────────────────────┐
                          │             cc-agent daemon             │
                          └─────────────────────────────────────────┘

 ┌────────┐  webhook   ┌──────────┐  enqueue   ┌────────┐  Claude Code   ┌──────┐
 │ Linear │ ────────▶  │  Fastify │ ────────▶  │ BullMQ │ ───────────▶   │ Plan │
 └────────┘            │  server  │            │  queue │               └──┬───┘
                       └──────────┘            └────────┘                  │
                                                                           ▼
┌──────────┐                                                        ┌───────────┐
│ Mark Done│                                                        │ Telegram  │
│ in Linear│                                                        │ approval  │
└────┬─────┘                                                        └─────┬─────┘
     ▲                                                                    │
     │                                                                    ▼
┌────┴────┐   check_suite   ┌─────────┐   git push   ┌──────────┐  ┌─────────┐
│ CI wait │ ◀────────────── │  GitHub  │ ◀─────────── │   Push   │◀─│  Impl   │
│         │    webhook      │         │               │ + PR     │  │ + Valid. │
└─────────┘                 └─────────┘               └──────────┘  └─────────┘
```

1. **Detection** — Linear webhook fires when an issue is assigned to the agent user
2. **Planning** — Claude Code explores the codebase and generates an implementation plan (read-only tools only)
3. **Approval** — Plan is sent to Telegram for human review (approve / reject / request changes)
4. **Implementation** — Claude Code implements the approved plan (dangerous commands gated via Telegram)
5. **Validation** — Runs lint, typecheck, build, and tests; auto-fixes failures (up to 3 retries)
6. **Push** — Changes are committed, pushed, and a PR is created
7. **CI wait** — Waits for GitHub check suite to pass (webhook-driven, 30 min polling fallback)
8. **Done** — Marks the Linear issue as Done; processes next sub-issue if any

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
pnpm run dev

# Production
pnpm run build
pnpm start
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

## Telegram Commands

| Command | Description |
|---|---|
| `/status` | List all active, failed, and delayed jobs |
| `/restart` | Resume the latest failed/delayed job from its current phase |
| `/retry` | Restart the latest failed/delayed job from scratch (plan phase) |
| `/kill` | Force-stop and remove a job (aborts in-flight execution) |

Failure notifications also include inline **Retry (resume)** and **Retry (fresh)** buttons.

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

## Extra features

- **Standing instructions** — Inject custom rules into planning and implementation prompts (e.g. "use TDD", "skip E2E tests", "use the frontend-design skill")
- **Structured logging** — Winston logger with JSON format, timestamps, and colorized console output
- **Rate-limit handling** — Automatically detects Claude API rate/token limits, notifies Telegram, pauses, and resumes from the stored session
- **Dangerous command gating** — Commands matching patterns like `rm -rf`, `DROP TABLE`, or `format /` require explicit Telegram approval before execution
- **Sub-issue support** — Parent issues with sub-issues are processed sequentially; a single branch and PR is created for all of them
- **Validation loop** — After implementation, runs lint/typecheck/build/tests and feeds failures back to Claude for auto-fix (up to 3 retries)
- **Crash recovery** — BullMQ persists jobs in Redis; on restart, stalled jobs are detected and resumed from their last phase and Claude session
- **Telegram commands** — `/status`, `/restart`, `/retry`, `/kill` for managing jobs on the go, plus inline retry buttons on failure notifications
