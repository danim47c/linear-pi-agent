import {
  createInstallationAccessToken,
  getGitHubAppInfo,
  getRepositoryInstallation,
  isGitHubAppConfigured,
  listGitHubInstallations,
} from "./github-app.js";

if (!isGitHubAppConfigured()) {
  console.log(JSON.stringify({ ok: false, configured: false, message: "GitHub App is not configured" }, null, 2));
  process.exit(0);
}

const app = await getGitHubAppInfo();
const installations = await listGitHubInstallations();
const repository = process.env.GITHUB_SMOKE_REPOSITORY;

const result: Record<string, unknown> = {
  ok: true,
  configured: true,
  app: { id: app.id, slug: app.slug, name: app.name, owner: app.owner?.login },
  installationCount: installations.length,
  installations: installations.map((installation) => ({
    id: installation.id,
    account: installation.account?.login,
    accountType: installation.account?.type,
    repositorySelection: installation.repository_selection,
  })),
};

if (repository) {
  const installation = await getRepositoryInstallation(repository);
  const token = await createInstallationAccessToken(installation.id, [repository]);
  result.repository = repository;
  result.repositoryInstallationId = installation.id;
  result.repositoryTokenExpiresAt = token.expires_at;
  result.repositoryPermissions = token.permissions;
}

console.log(JSON.stringify(result, null, 2));
