import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  initTheme,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { prepareGitHubCommandAuth, type GitHubCommandAuth } from "./github-installations.js";
import { createAgentActivity, type LinearRequestOptions } from "./linear.js";
import type { AgentSessionWebhook } from "./session-runner.js";
import { repositoryTargetSummary, resolveRepositoryTarget, type RepositoryTarget } from "./workspace-config.js";

const MAX_LINEAR_BODY_CHARS = 8_000;
const MAX_PROGRESS_CHARS = 220;
const MAX_THINKING_PROGRESS_CHARS = 1_800;

// Some installed pi extensions render background widgets even when pi is used
// through the SDK. Initialize the global theme so those non-interactive hooks
// do not crash the Linear service with "Theme not initialized".
initTheme(process.env.PI_THEME ?? "light", false);

export type PiRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputText: string;
  summary: string;
};

type ManagedSession = {
  session: AgentSession;
  unsubscribe: () => void;
  reporterRef: { current: ProgressReporter };
  workdir: string;
};

const sdkSessions = new Map<string, ManagedSession>();

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const maybeText = (part as { text?: unknown }).text;
      return typeof maybeText === "string" ? [maybeText] : [];
    })
    .join("\n");
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  return textFromContent((message as { content?: unknown }).content);
}

function finalAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    const text = messageText(message).trim();
    if (text) return text;
  }
  return undefined;
}

function redact(text: string): string {
  return text
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
}

function truncate(text: string, maxChars = MAX_PROGRESS_CHARS): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function truncatePreservingLines(text: string, maxChars: number): string {
  const clean = redact(text)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const record = args as Record<string, unknown>;
  const pathValue = record.path ?? record.file_path ?? record.filePath;
  if (typeof pathValue === "string") return `${toolName} ${pathValue}`;
  const command = record.command ?? record.cmd;
  if (typeof command === "string") return `${toolName} ${command}`;
  const query = record.query;
  if (typeof query === "string") return `${toolName} ${query}`;
  return toolName;
}

function guidanceText(payload: AgentSessionWebhook): string {
  const rules = payload.guidance?.flatMap((rule) => rule.body ? [rule.body] : []) ?? [];
  if (!rules.length) return "";
  return `\n\nLinear guidance:\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

function githubCredentialText(target?: RepositoryTarget): string | undefined {
  if (!target?.githubInstallationId || !target.repository) return undefined;
  return [
    "GitHub credentials:",
    "- GitHub App credentials are available to git and gh for this repository during the run.",
    "- Use git normally over the origin HTTPS remote; GIT_ASKPASS supplies the installation token.",
    "- gh is installed and GH_TOKEN/GITHUB_TOKEN are set for this repository.",
    "- Prefer creating a branch and PR instead of committing directly to the default branch.",
  ].join("\n");
}

export function buildPiPrompt(payload: AgentSessionWebhook, target?: RepositoryTarget): string {
  const issue = payload.agentSession?.issue;
  const promptContext = payload.promptContext ?? payload.agentSession?.promptContext;

  return [
    "You are running as Pi, a Linear custom agent powered by pi.",
    "Work directly in the selected repository with full control. Make code changes when appropriate.",
    "Do not expose secrets. Be concise in your final summary for Linear.",
    target ? `\nSelected repository context:\n${repositoryTargetSummary(target)}` : undefined,
    githubCredentialText(target) ? `\n${githubCredentialText(target)}` : undefined,
    "",
    issue ? "Linear issue:" : "Linear session:",
    issue?.identifier ? `- Identifier: ${issue.identifier}` : undefined,
    issue?.title ? `- Title: ${issue.title}` : undefined,
    issue?.url ? `- URL: ${issue.url}` : undefined,
    issue?.description ? `- Description:\n${issue.description}` : undefined,
    promptContext ? `\nLinear prompt context:\n${promptContext}` : undefined,
    guidanceText(payload),
    "",
    "When finished, summarize what changed, tests/checks run, and any remaining follow-up.",
  ].filter(Boolean).join("\n");
}

export function buildPiFollowUpPrompt(payload: AgentSessionWebhook): string {
  const followUp = payload.agentActivity?.content?.body?.trim();
  if (followUp) {
    return [
      "Linear user follow-up:",
      followUp,
      "",
      "Continue from the existing session context. Be concise in your final summary for Linear.",
    ].join("\n");
  }

  const promptContext = payload.promptContext ?? payload.agentSession?.promptContext;
  if (promptContext) {
    return [
      "Linear follow-up context:",
      promptContext,
      "",
      "Continue from the existing session context. Be concise in your final summary for Linear.",
    ].join("\n");
  }

  return "Linear sent a follow-up event without message text. Continue from the existing session context and summarize any useful status.";
}

export function summarizePiResult(result: PiRunResult): string {
  const combined = [result.outputText.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    return result.exitCode === 0 ? "pi finished successfully without output." : "pi failed without output.";
  }

  const safe = redact(combined);
  if (safe.length <= MAX_LINEAR_BODY_CHARS) return safe;
  return `${safe.slice(0, MAX_LINEAR_BODY_CHARS)}\n\n…output truncated…`;
}

type PendingProgressUpdate = {
  type: "thought" | "action";
  body: string;
  action?: string;
  parameter?: string;
  dedupeKey?: string;
  afterSend?: () => void;
};

class ProgressReporter {
  private pending?: PendingProgressUpdate;
  private timer?: NodeJS.Timeout;
  private lastSentAt = 0;
  private lastSentKey?: string;
  private thinkingBuffer = "";
  private thinkingSentOffset = 0;

  constructor(
    private readonly agentSessionId: string,
    private readonly options?: LinearRequestOptions,
  ) {}

  thought(body: string): void {
    this.queue({ type: "thought", body: truncate(body) });
  }

  beginThinking(): void {
    this.thinkingBuffer = "";
    this.thinkingSentOffset = 0;
  }

  thinkingDelta(delta: string): void {
    if (!delta) return;
    this.thinkingBuffer += delta;
    this.queueThinking();
  }

  endThinking(content?: string): void {
    if (content && !this.thinkingBuffer.trim()) {
      this.thinkingBuffer = content;
    }
    this.queueThinking();
    void this.flush();
  }

  action(action: string, parameter: string): void {
    // Keep tool/progress updates visible without leaving action-type entries
    // that may be interpreted by Linear as still-active work state.
    this.queue({
      type: "thought",
      body: truncate(`${action}: ${parameter}`),
    });
  }

  private queueThinking(): void {
    const unsent = this.thinkingBuffer.slice(this.thinkingSentOffset);
    const chunk = truncatePreservingLines(unsent, MAX_THINKING_PROGRESS_CHARS);
    if (!chunk) return;

    const sentThrough = this.thinkingBuffer.length;
    const body = `Pi thinking:\n${chunk}`;
    this.queue({
      type: "thought",
      body,
      dedupeKey: `thinking:${body}`,
      afterSend: () => {
        this.thinkingSentOffset = Math.max(this.thinkingSentOffset, sentThrough);
      },
    });
  }

  private queue(update: PendingProgressUpdate): void {
    if (!update.body.trim()) return;
    const dedupeKey = update.dedupeKey ?? `${update.type}:${update.action ?? ""}:${update.parameter ?? ""}:${update.body}`;
    if (this.pending?.dedupeKey === dedupeKey || this.lastSentKey === dedupeKey) return;

    this.pending = { ...update, dedupeKey };
    const wait = Math.max(0, config.PI_PROGRESS_DEBOUNCE_MS - (Date.now() - this.lastSentAt));
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), wait);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const update = this.pending;
    this.pending = undefined;
    if (!update) return;
    this.lastSentAt = Date.now();
    try {
      if (update.type === "action") {
        await createAgentActivity(this.agentSessionId, {
          type: "action",
          action: update.action ?? "Processing",
          parameter: update.parameter ?? update.body,
        }, this.options);
      } else {
        await createAgentActivity(this.agentSessionId, { type: "thought", body: update.body }, this.options);
      }
      this.lastSentKey = update.dedupeKey;
      update.afterSend?.();
    } catch (error) {
      console.error("failed to post pi progress", { message: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function getSdkSession(agentSessionId: string, reporter: ProgressReporter, workdir: string): Promise<ManagedSession> {
  const existing = sdkSessions.get(agentSessionId);
  if (existing) {
    if (existing.workdir !== workdir) {
      throw new Error(`Agent session ${agentSessionId} is already bound to ${existing.workdir}, not ${workdir}.`);
    }
    existing.reporterRef.current = reporter;
    return existing;
  }

  const sessionDir = path.resolve(config.PI_SESSION_DIR);
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${agentSessionId}.jsonl`);
  const sessionManager = SessionManager.open(sessionFile, sessionDir, workdir);
  const { session } = await createAgentSession({ cwd: workdir, sessionManager });

  const reporterRef = { current: reporter };
  const unsubscribe = session.subscribe((event) => handleSdkEvent(event, reporterRef.current));
  await session.bindExtensions({});

  const managed = { session, unsubscribe, reporterRef, workdir };
  sdkSessions.set(agentSessionId, managed);
  return managed;
}

function disposeSdkSession(agentSessionId: string): void {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed) return;
  managed.unsubscribe();
  managed.session.dispose();
  sdkSessions.delete(agentSessionId);
}

function applyProcessEnv(env: NodeJS.ProcessEnv): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function prepareCommandAuth(target: RepositoryTarget): Promise<GitHubCommandAuth | undefined> {
  if (!target.repository || !target.githubInstallationId) return undefined;
  try {
    const auth = await prepareGitHubCommandAuth(target.repository);
    if (auth) {
      console.log("github command credentials prepared", {
        repository: target.repository,
        installationId: target.githubInstallationId,
        expiresAt: auth.expiresAt,
      });
    }
    return auth;
  } catch (error) {
    console.error("failed to prepare github command credentials", {
      repository: target.repository,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function handleSdkEvent(event: AgentSessionEvent, reporter: ProgressReporter): void {
  switch (event.type) {
    case "agent_start":
      reporter.thought("Pi is starting the coding session.");
      break;
    case "turn_start":
      // Do not post a generic "Pi is thinking." for every model turn. Linear
      // renders every activity, so repeated turns otherwise show the same
      // status several times in a row. Real thinking content is streamed from
      // message_update/thinking_delta below.
      break;
    case "tool_execution_start":
      reporter.action(`Running ${event.toolName}`, summarizeToolArgs(event.toolName, event.args));
      break;
    case "tool_execution_end":
      if (event.isError) reporter.thought(`${event.toolName} reported an error; Pi is adjusting.`);
      break;
    case "message_update": {
      const messageEvent = event.assistantMessageEvent;
      if (messageEvent.type === "thinking_start") reporter.beginThinking();
      if (messageEvent.type === "thinking_delta") reporter.thinkingDelta(messageEvent.delta);
      if (messageEvent.type === "thinking_end") reporter.endThinking(messageEvent.content);
      break;
    }
    case "message_end":
      // Do not mirror assistant messages as progress thoughts. Linear uses the
      // latest activity to infer session state; duplicating the final answer as
      // a thought after the response can move a completed session back to active.
      break;
    case "compaction_start":
      reporter.thought("Pi is compacting context before continuing.");
      break;
    case "auto_retry_start":
      reporter.thought(`Pi is retrying after an error (${event.attempt}/${event.maxAttempts}).`);
      break;
    case "queue_update":
      break;
  }
}

export async function runPi(payload: AgentSessionWebhook, options?: LinearRequestOptions): Promise<PiRunResult> {
  if (config.PI_RUNNER === "cli") {
    throw new Error("CLI pi runner fallback was removed from this build path; set PI_RUNNER=sdk or restore the legacy runner.");
  }

  const agentSessionId = payload.agentSession?.id;
  if (!agentSessionId) throw new Error("agentSession.id is required to run pi");

  const target = await resolveRepositoryTarget(payload);
  console.log("pi repository target selected", {
    agentSessionId,
    workspaceKey: target.workspaceKey,
    repository: target.repository,
    workdir: target.workdir,
    source: target.source,
  });

  const prompt = payload.action === "prompted" ? buildPiFollowUpPrompt(payload) : buildPiPrompt(payload, target);
  const reporter = new ProgressReporter(agentSessionId, options);
  const managed = await getSdkSession(agentSessionId, reporter, target.workdir);
  let finalText = "";
  const captureFinal = managed.session.subscribe((event) => {
    if (event.type === "agent_end") finalText = finalAssistantText(event.messages) ?? finalText;
    if (event.type === "turn_end") finalText = messageText(event.message).trim() || finalText;
  });

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const commandAuth = await prepareCommandAuth(target);
  const restoreCommandEnv = commandAuth ? applyProcessEnv(commandAuth.env) : undefined;

  try {
    await Promise.race([
      managed.session.prompt(prompt),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("pi timed out"));
        }, config.PI_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);

    await reporter.flush();
    const result: PiRunResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      outputText: finalText,
      summary: "",
    };
    result.summary = summarizePiResult(result);
    return result;
  } catch (error) {
    if (timedOut) {
      try {
        await managed.session.abort();
      } catch (abortError) {
        console.error("pi abort failed; disposing SDK session", {
          message: abortError instanceof Error ? abortError.message : String(abortError),
        });
        disposeSdkSession(agentSessionId);
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const result: PiRunResult = {
      exitCode: timedOut ? null : 1,
      signal: null,
      timedOut,
      stdout: "",
      stderr: timedOut ? "" : message,
      outputText: finalText,
      summary: "",
    };
    result.summary = summarizePiResult(result);
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    captureFinal();
    restoreCommandEnv?.();
    await commandAuth?.cleanup().catch((cleanupError: unknown) => {
      console.error("failed to cleanup github command credentials", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });
  }
}

export async function queuePiFollowUp(agentSessionId: string, prompt: string): Promise<boolean> {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed?.session.isStreaming) return false;
  await managed.session.followUp(prompt);
  return true;
}

export async function abortPiSession(agentSessionId: string): Promise<boolean> {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed?.session.isStreaming) return false;
  await managed.session.abort();
  return true;
}
