import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import {
  createInstallationAccessToken,
  getGitHubInstallation,
  listInstallationRepositories,
  type GitHubRepository,
} from "./github-app.js";
import { readJsonFile, writePrivateJsonFile, type StateRecord } from "./storage.js";

const GITHUB_APP_INSTALL_TTL_MS = 20 * 60 * 1000;
const GITHUB_APP_INSTALL_URL = "https://github.com/apps";
const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";

type GitHubState = StateRecord & {
  kind: "install" | "oauth";
  workspaceKey?: string;
  defaultRepository?: string;
};

export type GitHubInstallationRecord = {
  id: number;
  accountLogin?: string;
  accountType?: string;
  targetType?: string;
  repositorySelection?: string;
  repositories: InstalledGitHubRepository[];
  installedAt: number;
  updatedAt: number;
};

export type InstalledGitHubRepository = {
  id: number;
  installationId: number;
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
};

export type RepositoryLink = {
  workspaceKey: string;
  teamKey?: string;
  defaultRepository: string;
  githubInstallationId: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceRepositoryLink = RepositoryLink;

type OAuthUserRecord = {
  login: string;
  id: number;
  authorizedAt: number;
};

type GitHubInstallationStore = {
  states: GitHubState[];
  installations: Record<string, GitHubInstallationRecord>;
  workspaceLinks: Record<string, RepositoryLink>;
  teamLinks: Record<string, RepositoryLink>;
  oauthUsers: Record<string, OAuthUserRecord>;
};

function now() {
  return Date.now();
}

function fallbackStore(): GitHubInstallationStore {
  return { states: [], installations: {}, workspaceLinks: {}, teamLinks: {}, oauthUsers: {} };
}

async function readStore(): Promise<GitHubInstallationStore> {
  const store = await readJsonFile<Partial<GitHubInstallationStore>>(config.GITHUB_INSTALLATION_STORE_PATH, fallbackStore());
  const current = now();
  return {
    states: (store.states ?? []).filter((state) => state.expires_at > current),
    installations: store.installations ?? {},
    workspaceLinks: store.workspaceLinks ?? {},
    teamLinks: store.teamLinks ?? {},
    oauthUsers: store.oauthUsers ?? {},
  };
}

async function writeStore(store: GitHubInstallationStore): Promise<void> {
  await writePrivateJsonFile(config.GITHUB_INSTALLATION_STORE_PATH, store);
}

export function normalizeRepository(value: string): string {
  return value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase();
}

function publicRepository(repository: GitHubRepository, installationId: number): InstalledGitHubRepository {
  return {
    id: repository.id,
    installationId,
    fullName: repository.full_name,
    name: repository.name,
    private: repository.private,
    defaultBranch: repository.default_branch,
    cloneUrl: repository.clone_url,
    htmlUrl: repository.html_url,
  };
}

function requireGitHubAppSlug(): string {
  if (!config.GITHUB_APP_SLUG) throw new Error("GITHUB_APP_SLUG is not configured.");
  return config.GITHUB_APP_SLUG;
}

function requireGitHubOAuthConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET || !config.GITHUB_REDIRECT_URI) {
    throw new Error("GitHub OAuth is not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and GITHUB_REDIRECT_URI.");
  }

  return {
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    redirectUri: config.GITHUB_REDIRECT_URI,
  };
}

async function createState(kind: GitHubState["kind"], metadata?: Partial<GitHubState>): Promise<string> {
  const state = crypto.randomBytes(32).toString("base64url");
  const current = now();
  const store = await readStore();

  store.states.push({
    state,
    kind,
    created_at: current,
    expires_at: current + GITHUB_APP_INSTALL_TTL_MS,
    workspaceKey: metadata?.workspaceKey,
    defaultRepository: metadata?.defaultRepository,
  });

  await writeStore(store);
  return state;
}

async function consumeState(state: string | undefined, kind: GitHubState["kind"]): Promise<GitHubState | undefined> {
  if (!state) return undefined;

  const store = await readStore();
  const current = now();
  const match = store.states.find((record) => record.state === state && record.kind === kind && record.expires_at > current);
  if (!match) return undefined;

  store.states = store.states.filter((record) => record.state !== state && record.expires_at > current);
  await writeStore(store);
  return match;
}

export async function createGitHubInstallUrl(metadata?: { workspaceKey?: string; defaultRepository?: string }): Promise<string> {
  const slug = requireGitHubAppSlug();
  const state = await createState("install", metadata);
  const url = new URL(`${GITHUB_APP_INSTALL_URL}/${slug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function createGitHubOAuthUrl(metadata?: { workspaceKey?: string; defaultRepository?: string }): Promise<string> {
  const oauth = requireGitHubOAuthConfig();
  const state = await createState("oauth", metadata);
  const url = new URL(GITHUB_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", oauth.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "read:user");
  return url.toString();
}

export async function refreshGitHubInstallation(installationId: number): Promise<GitHubInstallationRecord> {
  const installation = await getGitHubInstallation(installationId);
  const repositories = await listInstallationRepositories(installationId);
  const current = now();
  const store = await readStore();
  const existing = store.installations[String(installationId)];

  const record: GitHubInstallationRecord = {
    id: installationId,
    accountLogin: installation.account?.login,
    accountType: installation.account?.type,
    targetType: installation.target_type,
    repositorySelection: installation.repository_selection,
    repositories: repositories.map((repository) => publicRepository(repository, installationId)),
    installedAt: existing?.installedAt ?? current,
    updatedAt: current,
  };

  store.installations[String(installationId)] = record;
  await writeStore(store);
  return record;
}

export async function completeGitHubSetupCallback(params: {
  installationId: number;
  state?: string;
  setupAction?: string;
}): Promise<{ installation: GitHubInstallationRecord; state?: GitHubState; linked?: WorkspaceRepositoryLink }> {
  const state = await consumeState(params.state, "install");
  if (!state) {
    throw new Error("Invalid or expired GitHub setup state. Start the GitHub installation from Pippo Admin.");
  }

  const installation = await refreshGitHubInstallation(params.installationId);
  let linked: WorkspaceRepositoryLink | undefined;

  if (state?.workspaceKey && state.defaultRepository) {
    linked = await linkWorkspaceRepository(state.workspaceKey, state.defaultRepository);
  } else if (state?.workspaceKey && installation.repositories.length === 1) {
    linked = await linkWorkspaceRepository(state.workspaceKey, installation.repositories[0].fullName);
  }

  return { installation, state, linked };
}

export async function completeGitHubOAuthCallback(params: {
  code: string;
  state?: string;
}): Promise<{ login: string; id: number; state?: GitHubState }> {
  const oauth = requireGitHubOAuthConfig();
  const state = await consumeState(params.state, "oauth");
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    code: params.code,
    redirect_uri: oauth.redirectUri,
  });

  const tokenResponse = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = await tokenResponse.json() as { access_token?: string; error_description?: string };
  if (!tokenResponse.ok || !tokenJson.access_token) {
    throw new Error(`GitHub OAuth token exchange failed: ${tokenJson.error_description ?? `HTTP ${tokenResponse.status}`}`);
  }

  const userResponse = await fetch(`${GITHUB_API_URL}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenJson.access_token}`,
      "User-Agent": config.GITHUB_APP_SLUG ?? "pippo-linear-agent",
    },
  });
  const user = await userResponse.json() as { login?: string; id?: number; message?: string };
  if (!userResponse.ok || !user.login || !user.id) {
    throw new Error(`GitHub OAuth user query failed: ${user.message ?? `HTTP ${userResponse.status}`}`);
  }

  const store = await readStore();
  store.oauthUsers[user.login] = { login: user.login, id: user.id, authorizedAt: now() };
  await writeStore(store);
  return { login: user.login, id: user.id, state };
}

export async function listGitHubInstallState(): Promise<{
  installations: GitHubInstallationRecord[];
  repositories: InstalledGitHubRepository[];
  workspaceLinks: RepositoryLink[];
  teamLinks: RepositoryLink[];
  oauthUsers: OAuthUserRecord[];
}> {
  const store = await readStore();
  const installations = Object.values(store.installations);
  return {
    installations,
    repositories: installations.flatMap((installation) => installation.repositories),
    workspaceLinks: Object.values(store.workspaceLinks),
    teamLinks: Object.values(store.teamLinks),
    oauthUsers: Object.values(store.oauthUsers),
  };
}

export async function findInstalledRepository(repository: string): Promise<InstalledGitHubRepository | undefined> {
  const normalized = normalizeRepository(repository);
  const state = await listGitHubInstallState();
  return state.repositories.find((candidate) => normalizeRepository(candidate.fullName) === normalized);
}

function teamLinkKey(workspaceKey: string, teamKey: string): string {
  return `${workspaceKey}:${teamKey}`;
}

export async function linkWorkspaceRepository(
  workspaceKey: string,
  repository: string,
  teamKey?: string,
): Promise<RepositoryLink> {
  const installedRepository = await findInstalledRepository(repository);
  if (!installedRepository) {
    throw new Error(`GitHub repository ${repository} is not installed for this GitHub App.`);
  }

  const store = await readStore();
  const key = teamKey ? teamLinkKey(workspaceKey, teamKey) : workspaceKey;
  const existing = teamKey ? store.teamLinks[key] : store.workspaceLinks[key];
  const current = now();
  const link: RepositoryLink = {
    workspaceKey,
    teamKey,
    defaultRepository: installedRepository.fullName,
    githubInstallationId: installedRepository.installationId,
    createdAt: existing?.createdAt ?? current,
    updatedAt: current,
  };

  if (teamKey) {
    store.teamLinks[key] = link;
  } else {
    store.workspaceLinks[key] = link;
  }

  await writeStore(store);
  return link;
}

export async function selectInstalledRepository(options: {
  workspaceKey?: string;
  teamKey?: string;
  repositoryHint?: string;
}): Promise<InstalledGitHubRepository | undefined> {
  const state = await listGitHubInstallState();

  if (options.repositoryHint) {
    const match = state.repositories.find((repository) =>
      normalizeRepository(repository.fullName) === normalizeRepository(options.repositoryHint!),
    );
    if (!match) throw new Error(`Repository ${options.repositoryHint} is not installed for Pippo's GitHub App.`);
    return match;
  }

  if (options.workspaceKey && options.teamKey) {
    const linked = state.teamLinks.find((link) =>
      link.workspaceKey === options.workspaceKey && link.teamKey === options.teamKey,
    );
    if (linked) return findInstalledRepository(linked.defaultRepository);
  }

  if (options.workspaceKey) {
    const linked = state.workspaceLinks.find((link) => link.workspaceKey === options.workspaceKey);
    if (linked) return findInstalledRepository(linked.defaultRepository);
  }

  if (state.repositories.length === 1) return state.repositories[0];
  if (state.repositories.length === 0) return undefined;

  throw new Error(
    `Multiple GitHub repositories are installed. Say "repo: owner/repo" in Linear or open /admin to set a default.`,
  );
}

function repositoryWorkdir(repository: InstalledGitHubRepository): string {
  const [owner, name] = normalizeRepository(repository.fullName).split("/");
  return path.join(path.resolve(config.REPOSITORY_BASE_DIR), owner, name);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withGitAskPass<T>(token: string, callback: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pippo-git-"));
  const askPassPath = path.join(dir, "askpass.sh");
  await fs.writeFile(
    askPassPath,
    `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' x-access-token ;;\n  *Password*) printf '%s\\n' "$GITHUB_TOKEN" ;;\n  *) printf '\\n' ;;\nesac\n`,
    { mode: 0o700 },
  );

  try {
    return await callback({
      ...process.env,
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: "0",
      GITHUB_TOKEN: token,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runGit(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

export async function ensureLocalRepository(repository: InstalledGitHubRepository): Promise<string> {
  const workdir = repositoryWorkdir(repository);
  const token = await createInstallationAccessToken(repository.installationId, [repository.fullName]);
  const cloneUrl = `https://github.com/${repository.fullName}.git`;

  await fs.mkdir(path.dirname(workdir), { recursive: true, mode: 0o700 });

  await withGitAskPass(token.token, async (env) => {
    if (!(await pathExists(path.join(workdir, ".git")))) {
      await runGit(["clone", "--no-tags", cloneUrl, workdir], { env });
      return;
    }

    await runGit(["remote", "set-url", "origin", cloneUrl], { cwd: workdir, env });
    await runGit(["fetch", "--prune", "origin"], { cwd: workdir, env });
  });

  return workdir;
}
