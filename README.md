# Pi Linear Agent

Versioned source for a Pi-powered custom Linear agent.

## Repository placement

This service is designed to live in its own repository, separate from the application repository it operates on. Configure the target application workspace with `PI_WORKDIR`, while this agent's code, package files, deployment docs, and systemd template stay independently versioned.

Production secrets and mutable OAuth/pi session state should live outside git and are ignored by the included `.gitignore`.

## Files tracked here

- `src/` — TypeScript agent source
- `package.json` / `package-lock.json` — pinned Node dependencies
- `.env.example` — non-secret configuration template
- `systemd/pi-linear-agent.service.template` — user systemd unit template
- `README.md` — deploy and operating notes

Ignored locally: `.env`, `data/*.json`, `data/pi-sessions/`, `dist/`, `node_modules/`, and logs.

## Required env vars

Create a production `.env` outside git by copying `.env.example` and filling in your own values:

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

Use absolute `TOKEN_STORE_PATH` and `STATE_STORE_PATH` in production if restarts/deploys should not depend on the current working directory.

## Linear app settings

- OAuth callback: `https://your-domain.example/linear/oauth/callback`
- Webhook URL: `https://your-domain.example/linear/webhook`
- Scopes: `read,write,app:assignable,app:mentionable`
- Enable Agent Session events.

Expose public `/linear/*` and `/healthz` routes to this service, which listens on `127.0.0.1:8787` by default.

## Build and local checks

```bash
npm install
npm run typecheck
npm run build
```

Smoke tests require configured secrets and/or a running service:

```bash
# Hit the agent directly by default
npm run smoke:webhook
npm run smoke:linear

# If you keep a reverse proxy on another port, point smoke:webhook there instead:
# WEBHOOK_SMOKE_URL=http://127.0.0.1:3000/linear/webhook npm run smoke:webhook
```

Health check:

```bash
curl http://127.0.0.1:8787/healthz
```

## Deploy / restart workflow

1. Update code and commit it.
2. Build and install/reload the service:

   ```bash
   npm install
   npm run typecheck
   npm run build
   install -Dm644 systemd/pi-linear-agent.service.template \
     ~/.config/systemd/user/pi-linear-agent.service
   systemctl --user daemon-reload
   systemctl --user restart pi-linear-agent
   systemctl --user status pi-linear-agent
   ```

3. Watch logs:

   ```bash
   journalctl --user -u pi-linear-agent -f
   ```

To enable startup after host reboot:

```bash
systemctl --user enable pi-linear-agent
loginctl enable-linger "$USER"
```

## pi integration

The service embeds pi through the `@earendil-works/pi-coding-agent` SDK. It keeps a persistent SDK session per Linear `agentSession.id` in `data/pi-sessions/`, streams debounced safe progress updates to Linear, uses SDK `followUp` for active-session follow-ups, and calls `session.abort()` for stop/cancel requests.

Progress messages are truncated and obvious secret-looking values are redacted before posting to Linear.

## Recovery behavior and limitations

Active run/queue state is still in memory. A Node/systemd restart can lose an active run or queued follow-up prompt, although OAuth tokens and pi session history are persisted on disk.

The current implementation targets one Linear workspace/install. Multi-workspace token selection hardening is future work.
