import crypto from "node:crypto";
import fs from "node:fs/promises";
import { config } from "./config.js";

const GITHUB_API_URL = "https://api.github.com";
const USER_AGENT = config.GITHUB_APP_SLUG ?? "pippo-linear-agent";

type GitHubErrorResponse = {
  message?: string;
  documentation_url?: string;
};

export type GitHubAppInfo = {
  id: number;
  slug: string;
  name: string;
  owner?: { login?: string };
};

export type GitHubInstallation = {
  id: number;
  account?: { login?: string; type?: string };
  repository_selection?: string;
};

export type GitHubInstallationToken = {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: string;
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function isGitHubAppConfigured(): boolean {
  return Boolean(config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY_PATH);
}

async function readPrivateKey(): Promise<string> {
  if (!config.GITHUB_APP_PRIVATE_KEY_PATH) {
    throw new Error("GITHUB_APP_PRIVATE_KEY_PATH is not configured.");
  }
  return fs.readFile(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
}

export async function createGitHubAppJwt(): Promise<string> {
  if (!config.GITHUB_APP_ID) throw new Error("GITHUB_APP_ID is not configured.");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: String(config.GITHUB_APP_ID),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), await readPrivateKey());
  return `${signingInput}.${base64url(signature)}`;
}

async function githubRequest<T>(path: string, options: RequestInit & { token: string }): Promise<T> {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${options.token}`,
      ...options.headers,
    },
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) as unknown : undefined;

  if (!response.ok) {
    const error = json as GitHubErrorResponse | undefined;
    throw new Error(`GitHub API ${path} failed: ${error?.message ?? `HTTP ${response.status}`}`);
  }

  return json as T;
}

export async function githubAppRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  return githubRequest<T>(path, { ...options, token: await createGitHubAppJwt() });
}

export async function getGitHubAppInfo(): Promise<GitHubAppInfo> {
  return githubAppRequest<GitHubAppInfo>("/app");
}

export async function listGitHubInstallations(): Promise<GitHubInstallation[]> {
  return githubAppRequest<GitHubInstallation[]>("/app/installations");
}

export async function getRepositoryInstallation(repository: string): Promise<GitHubInstallation> {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid GitHub repository: ${repository}`);
  return githubAppRequest<GitHubInstallation>(`/repos/${owner}/${repo}/installation`);
}

export async function createInstallationAccessToken(
  installationId: number,
  repositories?: string[],
): Promise<GitHubInstallationToken> {
  const body: Record<string, unknown> = {};
  if (repositories?.length) body.repositories = repositories.map((repository) => repository.split("/")[1]);

  return githubAppRequest<GitHubInstallationToken>(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
