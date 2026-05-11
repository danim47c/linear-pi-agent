# Clanker Linear Agent

Versioned source for the Clanker custom Linear agent used by `your-domain.example`.

## Repository placement

This agent is intentionally vendored in Your app under `ops/clanker-linear-agent` instead of living only at `/home/exedev/clanker-linear-agent`. That keeps app proxy changes, agent code, package files, and deployment docs reviewable together while keeping production secrets and OAuth token stores outside git.

The older `/home/exedev/clanker-linear-agent` path may still hold the production `.env` and mutable `data/*.json` token files. Do not commit those files.

## Files tracked here

- `src/` — TypeScript agent source
- `package.json` / `package-lock.json` — pinned Node dependencies
- `.env.example` — non-secret configuration template
- `systemd/clanker-linear-agent.service.template` — user systemd unit template

Ignored locally: `.env`, `data/*.json`, `dist/`, `node_modules/`, and logs.

## Required env vars

Create a production `.env` outside git, for example `/home/exedev/clanker-linear-agent/.env`:

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
LINEAR_REDIRECT_URI=https://your-domain.example/linear/oauth/callback
BASE_URL=https://your-domain.example
PI_WORKDIR=/home/exedev/your-app
PI_COMMAND=pi
PI_MODE=json
PI_TIMEOUT_MS=1800000
HOST=127.0.0.1
PORT=8787
TOKEN_STORE_PATH=/home/exedev/clanker-linear-agent/data/linear-tokens.json
STATE_STORE_PATH=/home/exedev/clanker-linear-agent/data/oauth-states.json
```

Use absolute `TOKEN_STORE_PATH` and `STATE_STORE_PATH` in production so restarts/deploys do not depend on the checkout's current working directory.

## Linear app settings

- OAuth callback: `https://your-domain.example/linear/oauth/callback`
- Webhook URL: `https://your-domain.example/linear/webhook`
- Scopes: `read,write,app:assignable,app:mentionable`
- Enable Agent Session events.

Rails serves public `/linear/*` and `/healthz` routes on port 3000 and proxies them to this service on `127.0.0.1:8787`.

## Build and local checks

```bash
cd /home/exedev/your-app/ops/clanker-linear-agent
npm install
npm run build
npm run typecheck
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

1. Update code under `ops/clanker-linear-agent` and commit it through Your app.
2. On the server:

   ```bash
   cd /home/exedev/your-app/ops/clanker-linear-agent
   npm install
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

By default the service runs `pi --mode json -p <prompt>` and extracts the final assistant response from pi's JSONL output before posting back to Linear. Set `PI_MODE=text` to fall back to plain `pi -p <prompt>` output.

The Entire CLI issue about native pi integration (entireio/cli#221) is directionally useful for future hardening because it confirms pi JSONL sessions and extension hooks can expose richer session metadata. It is not required for this versioning work, but it is relevant to future session-link/plan-update improvements.

## Recovery behavior and limitations

Current session queue state is in memory. A Node/systemd restart can lose an active run or queued follow-up prompt. OAuth tokens and OAuth state are persisted to the configured JSON files with private `0600` permissions.
