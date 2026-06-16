import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { readJsonFile } from "./storage.js";
import type { AgentSessionWebhook } from "./session-runner.js";

const RepositoryConfigSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
  workdir: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
  branchPrefix: z.string().min(1).default("pippo"),
  githubInstallationId: z.number().int().positive().optional(),
});

const WorkspaceConfigSchema = z.object({
  name: z.string().optional(),
  defaultRepository: z.string().optional(),
  repositories: z.record(RepositoryConfigSchema).default({}),
});

const WorkspaceConfigStoreSchema = z.object({
  defaultWorkspaceKey: z.string().optional(),
  workspaces: z.record(WorkspaceConfigSchema).default({}),
});

export type RepositoryTarget = {
  workspaceKey?: string;
  workspaceName?: string;
  repositoryKey?: string;
  repository?: string;
  workdir: string;
  defaultBranch: string;
  branchPrefix: string;
  githubInstallationId?: number;
  source: "workspace-config" | "fallback";
};

type WorkspaceConfigStore = z.infer<typeof WorkspaceConfigStoreSchema>;
type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;

function fallbackTarget(): RepositoryTarget {
  return {
    workdir: path.resolve(config.PI_WORKDIR),
    defaultBranch: "main",
    branchPrefix: "pippo",
    source: "fallback",
  };
}

async function readWorkspaceConfig(): Promise<WorkspaceConfigStore> {
  const raw = await readJsonFile<unknown>(config.WORKSPACE_CONFIG_PATH, { workspaces: {} });
  return WorkspaceConfigStoreSchema.parse(raw);
}

function normalizeRepository(value: string): string {
  return value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").toLowerCase();
}

function workspaceCandidates(payload: AgentSessionWebhook, store: WorkspaceConfigStore): string[] {
  return [
    payload.organizationId,
    payload.organization?.id,
    payload.organization?.urlKey,
    payload.agentSession?.organization?.id,
    payload.agentSession?.organization?.urlKey,
    store.defaultWorkspaceKey,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
}

function payloadText(payload: AgentSessionWebhook): string {
  return [
    payload.agentActivity?.content?.body,
    payload.promptContext,
    payload.agentSession?.promptContext,
    payload.agentSession?.issue?.identifier,
    payload.agentSession?.issue?.title,
    payload.agentSession?.issue?.description,
  ].filter(Boolean).join("\n");
}

export function repositoryHintFromPayload(payload: AgentSessionWebhook): string | undefined {
  const text = payloadText(payload);
  const explicit = text.match(/(?:^|[\s,;])(?:repo|repository|github)\s*[:=]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
  if (explicit?.[1]) return normalizeRepository(explicit[1]);

  const mention = text.match(/(?:^|\s)@([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
  if (mention?.[1]) return normalizeRepository(mention[1]);

  return undefined;
}

function selectWorkspace(store: WorkspaceConfigStore, candidates: string[]): [string, WorkspaceConfig] | undefined {
  for (const candidate of candidates) {
    const workspace = store.workspaces[candidate];
    if (workspace) return [candidate, workspace];
  }

  const entries = Object.entries(store.workspaces);
  if (entries.length === 1) return entries[0];
  return undefined;
}

function selectRepository(
  workspace: WorkspaceConfig,
  hint: string | undefined,
): [string, RepositoryConfig] | undefined {
  const repositories = Object.entries(workspace.repositories);
  if (!repositories.length) return undefined;

  if (hint) {
    const direct = workspace.repositories[hint];
    if (direct) return [hint, direct];

    const matching = repositories.find(([key, repo]) =>
      normalizeRepository(key) === hint || (repo.repository && normalizeRepository(repo.repository) === hint),
    );
    if (matching) return matching;

    throw new Error(`Repository ${hint} is not configured for this Linear workspace.`);
  }

  if (workspace.defaultRepository) {
    const direct = workspace.repositories[workspace.defaultRepository];
    if (direct) return [workspace.defaultRepository, direct];

    const normalizedDefault = normalizeRepository(workspace.defaultRepository);
    const matching = repositories.find(([key, repo]) =>
      normalizeRepository(key) === normalizedDefault ||
      (repo.repository && normalizeRepository(repo.repository) === normalizedDefault),
    );
    if (matching) return matching;

    throw new Error(`Default repository ${workspace.defaultRepository} is not configured for this Linear workspace.`);
  }

  return repositories[0];
}

async function assertWorkdirExists(workdir: string): Promise<void> {
  try {
    const stat = await fs.stat(workdir);
    if (!stat.isDirectory()) throw new Error(`${workdir} is not a directory`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Configured repository workdir does not exist: ${workdir}`);
    }
    throw error;
  }
}

export async function resolveRepositoryTarget(payload: AgentSessionWebhook): Promise<RepositoryTarget> {
  const store = await readWorkspaceConfig();
  const candidates = workspaceCandidates(payload, store);
  const selectedWorkspace = selectWorkspace(store, candidates);

  if (!selectedWorkspace) return fallbackTarget();

  const [workspaceKey, workspace] = selectedWorkspace;
  const selectedRepository = selectRepository(workspace, repositoryHintFromPayload(payload));
  if (!selectedRepository) return fallbackTarget();

  const [repositoryKey, repository] = selectedRepository;
  const workdir = path.resolve(repository.workdir);
  await assertWorkdirExists(workdir);

  return {
    workspaceKey,
    workspaceName: workspace.name,
    repositoryKey,
    repository: repository.repository ?? repositoryKey,
    workdir,
    defaultBranch: repository.defaultBranch,
    branchPrefix: repository.branchPrefix,
    githubInstallationId: repository.githubInstallationId,
    source: "workspace-config",
  };
}

export function repositoryTargetSummary(target: RepositoryTarget): string {
  return [
    target.repository ? `Repository: ${target.repository}` : undefined,
    target.workspaceName ? `Workspace: ${target.workspaceName}` : target.workspaceKey ? `Workspace key: ${target.workspaceKey}` : undefined,
    `Workdir: ${target.workdir}`,
  ].filter(Boolean).join("\n");
}
