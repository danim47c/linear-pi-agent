# Linear Pi Agent

Connect your own `pi` coding agent to Linear. This service is one way to do that: Linear sends Agent Session events to this app, this app runs `pi` against your chosen repository, and progress/results are sent back to Linear.

The agent service is intended to live in its own repository, separate from the application repository it operates on. Configure the target application repository with `PI_WORKDIR`.

Repository: https://github.com/hiasinho/linear-pi-agent

## Easy install with a coding agent

If you want the easiest setup path, copy the contents of [`INSTALL.md`](./INSTALL.md) into your coding agent and ask it to follow the instructions. It will do the local setup steps it can do automatically and prompt you only for Linear setup, secrets, browser actions, or infrastructure details it cannot complete itself.

## How it works

```text
Linear Agent Session
  -> webhook to this service
  -> pi SDK session
  -> target repository at PI_WORKDIR
  -> progress/results back to Linear
```

The service:

- exposes OAuth install and webhook endpoints for Linear
- stores Linear OAuth tokens locally
- keeps a persistent pi SDK session per Linear `agentSession.id`
- supports follow-up prompts on active sessions
- handles stop/cancel requests by aborting the pi session
- redacts obvious secret-looking values from progress updates

## Linear setup

Create a Linear OAuth application from:

```text
Linear Settings -> API -> New OAuth app
```

Use Linear's docs for the full details of OAuth apps, webhooks, and Agent Sessions:

- OAuth: https://linear.app/developers/oauth-2-0-authentication
- Webhooks: https://linear.app/developers/webhooks
- Agent best practices: https://linear.app/developers/agent-best-practices

At a high level, configure the app with these service URLs:

| Linear setting | Value |
| --- | --- |
| OAuth callback URL | `https://your-domain.example/linear/oauth/callback` |
| Webhook URL | `https://your-domain.example/linear/webhook` |

Required OAuth scopes:

```text
read, write, app:assignable, app:mentionable
```

Enable Agent Session events for the webhook.

After the service is running, install the app by visiting:

```text
https://your-domain.example/linear/install
```

This redirects through Linear OAuth and stores the app token locally.

## Requirements

- Node.js and npm
- `pi` available to the service, or the pi SDK configured through dependencies
- a public HTTPS URL that Linear can reach
- a reverse proxy or tunnel forwarding public traffic to this service
- a target repository for pi to operate on

By default the service listens on `127.0.0.1:8787`. Expose these routes publicly:

- `/linear/install`
- `/linear/oauth/callback`
- `/linear/webhook`
- `/healthz` optional, for health checks

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
LINEAR_REDIRECT_URI=https://your-domain.example/linear/oauth/callback
BASE_URL=https://your-domain.example

PI_WORKDIR=/path/to/your/app
PI_COMMAND=pi
PI_MODE=json
PI_RUNNER=sdk
PI_SESSION_DIR=./data/pi-sessions
PI_PROGRESS_DEBOUNCE_MS=3000
PI_TIMEOUT_MS=1800000

HOST=127.0.0.1
PORT=8787
TOKEN_STORE_PATH=./data/linear-tokens.json
STATE_STORE_PATH=./data/oauth-states.json
```

Important values:

- `BASE_URL` — public URL for this service, without a trailing slash
- `LINEAR_REDIRECT_URI` — must exactly match the OAuth callback URL configured in Linear
- `LINEAR_WEBHOOK_SECRET` — Linear webhook signing secret
- `PI_WORKDIR` — the repository pi should work in
- `PI_SESSION_DIR` — persisted pi SDK session state
- `TOKEN_STORE_PATH` / `STATE_STORE_PATH` — persisted Linear OAuth state

Use absolute paths for token, state, and session storage in production.

## Build and check

```bash
npm install
npm run typecheck
npm run build
```

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

Smoke tests require configured secrets and/or a running service:

```bash
npm run smoke:webhook
npm run smoke:linear
```

If a reverse proxy listens on another port, point the webhook smoke test at it:

```bash
WEBHOOK_SMOKE_URL=http://127.0.0.1:3000/linear/webhook npm run smoke:webhook
```

## Deploy with systemd

Install/reload the user service:

```bash
npm install
npm run typecheck
npm run build
install -Dm644 systemd/linear-pi-agent.service.template \
  ~/.config/systemd/user/linear-pi-agent.service
systemctl --user daemon-reload
systemctl --user restart linear-pi-agent
systemctl --user status linear-pi-agent
```

Watch logs:

```bash
journalctl --user -u linear-pi-agent -f
```

Enable startup after host reboot:

```bash
systemctl --user enable linear-pi-agent
loginctl enable-linger "$USER"
```

## Repository layout

- `src/` — TypeScript service source
- `systemd/linear-pi-agent.service.template` — user systemd unit template
- `.env.example` — configuration template
- `data/` — local OAuth and pi session state, ignored by git
- `dist/` — compiled output, ignored by git

Ignored locally: `.env`, `data/*.json`, `data/pi-sessions/`, `dist/`, `node_modules/`, and logs.

## Operational notes

Active run and queue state is currently in memory. A Node/systemd restart can lose an active run or queued follow-up prompt, although OAuth tokens and pi session history are persisted on disk.

The current implementation targets one Linear workspace/install. Multi-workspace token selection hardening is future work.
