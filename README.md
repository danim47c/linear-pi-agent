# Clanker Linear Agent

Versioned source for the Clanker custom Linear agent used by `your-domain.example`.

## Repository placement

This agent intentionally lives in its own repo at `/home/exedev/clanker-linear-agent`, outside the Your app Rails repo. The agent can still operate on Your app through `PI_WORKDIR=/home/exedev/your-app`, while its code, package files, deployment docs, and systemd template stay independently versioned.

Production secrets and mutable OAuth/pi session state also live under this directory, but are ignored by git.

## Files tracked here

- `src/` — TypeScript agent source
- `package.json` / `package-lock.json` — pinned Node dependencies
- `.env.example` — non-secret configuration template
- `systemd/clanker-linear-agent.service.template` — user systemd unit template
- `README.md` — deploy and operating notes

Ignored locally: `.env`, `data/*.json`, `data/pi-sessions/`, `dist/`, `node_modules/`, and logs.

## Required env vars

Create a production `.env` outside git at `/home/exedev/clanker-linear-agent/.env`:

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
LINEAR_REDIRECT_URI=https://your-domain.example/linear/oauth/callback
BASE_URL=https://your-domain.example
PI_WORKDIR=/home/exedev/your-app
PI_COMMAND=pi
PI_MODE=json
PI_RUNNER=sdk
PI_SESSION_DIR=./data/pi-sessions
PI_PROGRESS_DEBOUNCE_MS=3000
PI_TIMEOUT_MS=1800000
HOST=127.0.0.1
PORT=8787
TOKEN_STORE_PATH=/home/exedev/clanker-linear-agent/data/linear-tokens.json
STATE_STORE_PATH=/home/exedev/clanker-linear-agent/data/oauth-states.json
```

Use absolute `TOKEN_STORE_PATH` and `STATE_STORE_PATH` in production so restarts/deploys do not depend on the current working directory.

## Linear app settings

- OAuth callback: `https://your-domain.example/linear/oauth/callback`
- Webhook URL: `https://your-domain.example/linear/webhook`
- Scopes: `read,write,app:assignable,app:mentionable`
- Enable Agent Session events.

Rails serves public `/linear/*` and `/healthz` routes on port 3000 and proxies them to this service on `127.0.0.1:8787`.

## Build and local checks

```bash
cd /home/exedev/clanker-linear-agent
npm install
npm run typecheck
npm run build
```

Smoke tests that require configured secrets and/or a running service:

```bash
npm run smoke:webhook
npm run smoke:linear
```

Health checks:

```bash
curl http://127.0.0.1:8787/healthz
curl http://127.0.0.1:3000/healthz
```

## Deploy / restart workflow

1. Update code in `/home/exedev/clanker-linear-agent` and commit it.
2. Build and install/reload the service:

   ```bash
   cd /home/exedev/clanker-linear-agent
   npm install
   npm run typecheck
   npm run build
   install -Dm644 systemd/clanker-linear-agent.service.template \
     /home/exedev/.config/systemd/user/clanker-linear-agent.service
   systemctl --user daemon-reload
   systemctl --user restart clanker-linear-agent
   systemctl --user status clanker-linear-agent
   ```

3. Watch logs:

   ```bash
   journalctl --user -u clanker-linear-agent -f
   ```

To enable startup after host reboot:

```bash
systemctl --user enable clanker-linear-agent
sudo loginctl enable-linger exedev
```

## pi integration

The service embeds pi through the `@earendil-works/pi-coding-agent` SDK. It keeps a persistent SDK session per Linear `agentSession.id` in `data/pi-sessions/`, streams debounced safe progress updates to Linear, uses SDK `followUp` for active-session follow-ups, and calls `session.abort()` for stop/cancel requests.

Progress messages are truncated and obvious secret-looking values are redacted before posting to Linear.

## Recovery behavior and limitations

Active run/queue state is still in memory. A Node/systemd restart can lose an active run or queued follow-up prompt, although OAuth tokens and pi session history are persisted on disk. This is the remaining scope of STR-11.

The current deployment targets one Linear workspace/install. Multi-workspace token selection hardening is remaining scope of STR-13.
