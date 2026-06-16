import { publicConfig } from "./config.js";
import type { RepositoryLink, InstalledGitHubRepository } from "./github-installations.js";
import type { LinearInstallationSummary, LinearTeamSummary } from "./linear.js";

type AdminLinearInstallation = LinearInstallationSummary & {
  workspaceKey: string;
  teams?: LinearTeamSummary[];
  teamsError?: string;
};

type AdminGitHubState = {
  installations: Array<{
    id: number;
    accountLogin?: string;
    accountType?: string;
    repositorySelection?: string;
    repositories: InstalledGitHubRepository[];
  }>;
  repositories: InstalledGitHubRepository[];
  workspaceLinks: RepositoryLink[];
  teamLinks: RepositoryLink[];
  oauthUsers: Array<{ login: string; id: number; authorizedAt: number }>;
};

export type AdminPageData = {
  linearInstallations: AdminLinearInstallation[];
  github: AdminGitHubState;
  notice?: string;
  error?: string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(timestamp?: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
}

function workspaceLabel(workspace: AdminLinearInstallation): string {
  return workspace.organizationName ?? workspace.organizationUrlKey ?? workspace.organizationId ?? workspace.key;
}

function teamLabel(team?: LinearTeamSummary): string {
  if (!team) return "All teams";
  return `${team.name} (${team.key})`;
}

function scopeLabel(link: RepositoryLink, linearInstallations: AdminLinearInstallation[]): string {
  const workspace = linearInstallations.find((candidate) => candidate.workspaceKey === link.workspaceKey);
  const team = workspace?.teams?.find((candidate) => candidate.id === link.teamKey || candidate.key === link.teamKey);
  const workspaceText = workspace ? workspaceLabel(workspace) : link.workspaceKey;
  return link.teamKey ? `${workspaceText} / ${teamLabel(team)}` : `${workspaceText} / All teams`;
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --bg:#0f1115; --panel:#171a21; --text:#f4f6fb; --muted:#a5adbd; --line:#2b3040; --accent:#8b5cf6; --ok:#22c55e; --bad:#ef4444; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1120px; margin:0 auto; padding:32px 18px 60px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:24px; }
    h1 { font-size:28px; margin:0; letter-spacing:-0.03em; }
    h2 { font-size:18px; margin:0 0 14px; }
    a { color:#c4b5fd; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:18px; box-shadow:0 10px 30px rgba(0,0,0,.18); }
    .muted { color:var(--muted); }
    .pill { display:inline-flex; align-items:center; gap:6px; padding:4px 9px; border-radius:999px; border:1px solid var(--line); color:var(--muted); font-size:12px; }
    .pill.ok { color:#86efac; border-color:rgba(34,197,94,.35); }
    .pill.bad { color:#fca5a5; border-color:rgba(239,68,68,.35); }
    .actions { display:flex; gap:10px; flex-wrap:wrap; }
    button, .button { appearance:none; border:0; border-radius:10px; padding:10px 13px; background:var(--accent); color:white; font-weight:650; text-decoration:none; cursor:pointer; display:inline-flex; align-items:center; gap:8px; }
    .button.secondary, button.secondary { background:#272b38; color:var(--text); border:1px solid var(--line); }
    input, select { width:100%; box-sizing:border-box; background:#0f1115; color:var(--text); border:1px solid var(--line); border-radius:10px; padding:10px 11px; }
    label { display:block; margin:10px 0 6px; color:var(--muted); font-size:13px; }
    table { width:100%; border-collapse:collapse; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:10px 8px; vertical-align:top; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
    .notice { border:1px solid rgba(34,197,94,.35); background:rgba(34,197,94,.08); color:#bbf7d0; border-radius:12px; padding:12px 14px; margin-bottom:16px; }
    .error { border:1px solid rgba(239,68,68,.35); background:rgba(239,68,68,.08); color:#fecaca; border-radius:12px; padding:12px 14px; margin-bottom:16px; }
    .small { font-size:12px; }
    code { color:#ddd6fe; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderLoginPage(error?: string): string {
  return shell("Pippo Admin Login", `
    <div style="max-width:420px;margin:10vh auto 0" class="card">
      <h1>Pippo Admin</h1>
      <p class="muted">Enter the install secret to manage Linear ↔ GitHub routing.</p>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="/admin/login">
        <label for="install_secret">Install secret</label>
        <input id="install_secret" name="install_secret" type="password" autocomplete="current-password" autofocus />
        <div style="margin-top:14px"><button type="submit">Log in</button></div>
      </form>
    </div>
  `);
}

export function renderAdminPage(data: AdminPageData): string {
  const cfg = publicConfig();
  const githubConfigured = cfg.githubAppConfigured;
  const oauthConfigured = cfg.githubOAuthConfigured;
  const repoOptions = data.github.repositories
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((repo) => `<option value="${escapeHtml(repo.fullName)}">${escapeHtml(repo.fullName)}</option>`)
    .join("");

  const scopeOptions = data.linearInstallations.flatMap((workspace) => {
    const value = `${workspace.workspaceKey}|`;
    const options = [`<option value="${escapeHtml(value)}">${escapeHtml(workspaceLabel(workspace))} / All teams</option>`];
    for (const team of workspace.teams ?? []) {
      options.push(`<option value="${escapeHtml(`${workspace.workspaceKey}|${team.id}`)}">${escapeHtml(workspaceLabel(workspace))} / ${escapeHtml(teamLabel(team))}</option>`);
    }
    return options;
  }).join("");

  const linearRows = data.linearInstallations.length ? data.linearInstallations.map((workspace) => `
    <tr>
      <td>${escapeHtml(workspaceLabel(workspace))}<div class="muted small">${escapeHtml(workspace.organizationUrlKey ?? "")}</div></td>
      <td><code>${escapeHtml(workspace.workspaceKey)}</code></td>
      <td>${workspace.teamsError ? `<span class="pill bad">${escapeHtml(workspace.teamsError)}</span>` : `${workspace.teams?.length ?? 0}`}</td>
    </tr>
  `).join("") : `<tr><td colspan="3" class="muted">No Linear workspace installed yet.</td></tr>`;

  const repoRows = data.github.repositories.length ? data.github.repositories.map((repo) => `
    <tr>
      <td><a href="${escapeHtml(repo.htmlUrl)}">${escapeHtml(repo.fullName)}</a></td>
      <td>${escapeHtml(repo.defaultBranch)}</td>
      <td>${repo.private ? "private" : "public"}</td>
      <td><code>${escapeHtml(repo.installationId)}</code></td>
    </tr>
  `).join("") : `<tr><td colspan="4" class="muted">No GitHub repositories installed yet.</td></tr>`;

  const links = [...data.github.workspaceLinks, ...data.github.teamLinks]
    .sort((a, b) => scopeLabel(a, data.linearInstallations).localeCompare(scopeLabel(b, data.linearInstallations)));
  const linkRows = links.length ? links.map((link) => `
    <tr>
      <td>${escapeHtml(scopeLabel(link, data.linearInstallations))}</td>
      <td><code>${escapeHtml(link.teamKey ? "team" : "workspace")}</code></td>
      <td>${escapeHtml(link.defaultRepository)}</td>
      <td>${escapeHtml(fmtDate(link.updatedAt))}</td>
    </tr>
  `).join("") : `<tr><td colspan="4" class="muted">No default links yet. If exactly one repo is installed, a link is optional.</td></tr>`;

  return shell("Pippo Admin", `
    <header>
      <div>
        <h1>Pippo Admin</h1>
        <div class="muted">Linear workspaces/teams ↔ GitHub repositories</div>
      </div>
      <div class="actions">
        <a class="button secondary" href="/github/status">JSON status</a>
        <a class="button secondary" href="/admin/logout">Log out</a>
      </div>
    </header>

    ${data.notice ? `<div class="notice">${escapeHtml(data.notice)}</div>` : ""}
    ${data.error ? `<div class="error">${escapeHtml(data.error)}</div>` : ""}

    <section class="grid">
      <div class="card">
        <h2>Linear</h2>
        <p><span class="pill ${data.linearInstallations.length ? "ok" : "bad"}">${data.linearInstallations.length} workspace(s)</span></p>
        <p class="muted">Install Pippo in every Linear workspace you want to automate.</p>
        <a class="button" href="/linear/install">Install Linear app</a>
      </div>
      <div class="card">
        <h2>GitHub</h2>
        <p>
          <span class="pill ${githubConfigured ? "ok" : "bad"}">App ${githubConfigured ? "configured" : "not configured"}</span>
          <span class="pill ${oauthConfigured ? "ok" : "bad"}">OAuth ${oauthConfigured ? "configured" : "not configured"}</span>
        </p>
        <p class="muted">Install or update the GitHub App repository selection.</p>
        <div class="actions">
          <a class="button" href="/github/install">Install GitHub app</a>
          <a class="button secondary" href="/github/oauth/start">GitHub OAuth</a>
        </div>
      </div>
      <div class="card">
        <h2>Routing</h2>
        <p class="muted">Set a default repo per Linear workspace or per Linear team. Team default wins over workspace default.</p>
        <p><code>repo: owner/repo</code> in Linear still overrides defaults for one session.</p>
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <h2>Create/update default link</h2>
      <form method="post" action="/admin/link">
        <div class="grid">
          <div>
            <label for="scope">Linear workspace/team</label>
            <select id="scope" name="scope" ${scopeOptions ? "" : "disabled"}>${scopeOptions || `<option>No Linear workspace installed</option>`}</select>
          </div>
          <div>
            <label for="repo">GitHub repository</label>
            <select id="repo" name="repo" ${repoOptions ? "" : "disabled"}>${repoOptions || `<option>No GitHub repository installed</option>`}</select>
          </div>
        </div>
        <div style="margin-top:14px"><button type="submit" ${scopeOptions && repoOptions ? "" : "disabled"}>Save default</button></div>
      </form>
    </section>

    <section class="grid" style="margin-top:16px">
      <div class="card">
        <h2>Linear workspaces</h2>
        <table><thead><tr><th>Workspace</th><th>Key</th><th>Teams</th></tr></thead><tbody>${linearRows}</tbody></table>
      </div>
      <div class="card">
        <h2>GitHub repositories</h2>
        <table><thead><tr><th>Repository</th><th>Default branch</th><th>Visibility</th><th>Installation</th></tr></thead><tbody>${repoRows}</tbody></table>
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <h2>Existing defaults</h2>
      <table><thead><tr><th>Scope</th><th>Type</th><th>Repository</th><th>Updated</th></tr></thead><tbody>${linkRows}</tbody></table>
    </section>
  `);
}
