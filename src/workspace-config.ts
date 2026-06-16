import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { AgentSessionWebhook } from "./session-runner.js";
import {
  ensureLocalRepository,
  normalizeRepository,
  selectInstalledRepository,
} from "./github-installations.js";

export type RepositoryTarget = {
  workspaceKey?: string;
  teamKey?: string;
  repositoryKey?: string;
  repository?: string;
  repositoryUrl?: string;
  workdir: string;
  defaultBranch: string;
  branchPrefix: string;
  githubInstallationId?: number;
  source: "github-app" | "fallback";
};

function fallbackTarget(): RepositoryTarget {
  return {
    workdir: path.resolve(config.PI_WORKDIR),
    defaultBranch: "main",
    branchPrefix: "pippo",
    source: "fallback",
  };
}

export function workspaceKeyFromWebhook(payload: AgentSessionWebhook): string | undefined {
  return payload.organizationId ??
    payload.organization?.id ??
    payload.organization?.urlKey ??
    payload.agentSession?.organization?.id ??
    payload.agentSession?.organization?.urlKey;
}

export function teamKeyFromWebhook(payload: AgentSessionWebhook): string | undefined {
  return payload.team?.id ??
    payload.team?.key ??
    payload.agentSession?.team?.id ??
    payload.agentSession?.team?.key ??
    payload.agentSession?.issue?.team?.id ??
    payload.agentSession?.issue?.team?.key;
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

async function assertWorkdirExists(workdir: string): Promise<void> {
  const stat = await fs.stat(workdir);
  if (!stat.isDirectory()) throw new Error(`${workdir} is not a directory`);
}

export async function resolveRepositoryTarget(payload: AgentSessionWebhook): Promise<RepositoryTarget> {
  const workspaceKey = workspaceKeyFromWebhook(payload);
  const teamKey = teamKeyFromWebhook(payload);
  const repositoryHint = repositoryHintFromPayload(payload);
  const installedRepository = await selectInstalledRepository({ workspaceKey, teamKey, repositoryHint });

  if (!installedRepository) {
    const fallback = fallbackTarget();
    await assertWorkdirExists(fallback.workdir);
    return fallback;
  }

  const workdir = await ensureLocalRepository(installedRepository);
  return {
    workspaceKey,
    teamKey,
    repositoryKey: normalizeRepository(installedRepository.fullName),
    repository: installedRepository.fullName,
    repositoryUrl: installedRepository.htmlUrl,
    workdir,
    defaultBranch: installedRepository.defaultBranch,
    branchPrefix: "pippo",
    githubInstallationId: installedRepository.installationId,
    source: "github-app",
  };
}

export function repositoryTargetSummary(target: RepositoryTarget): string {
  return [
    target.repository ? `Repository: ${target.repository}` : undefined,
    target.repositoryUrl ? `Repository URL: ${target.repositoryUrl}` : undefined,
    target.workspaceKey ? `Workspace key: ${target.workspaceKey}` : undefined,
    target.teamKey ? `Team key: ${target.teamKey}` : undefined,
    `Workdir: ${target.workdir}`,
    `Source: ${target.source}`,
  ].filter(Boolean).join("\n");
}
