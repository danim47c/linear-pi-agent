import path from "node:path";
import { config } from "./config.js";
import { createAgentActivity } from "./linear.js";
import { abortPiSession, buildPiFollowUpPrompt, queuePiFollowUp, runPi } from "./pi-runner.js";
import { readJsonFile, writePrivateJsonFile } from "./storage.js";

type SessionState = {
  running: boolean;
  pendingPayload?: AgentSessionWebhook;
  lastStartedAt?: number;
  installationKey?: string;
};

export type AgentSessionWebhook = {
  action?: string;
  organizationId?: string;
  organization?: {
    id?: string;
    urlKey?: string;
  };
  team?: {
    id?: string;
    key?: string;
    name?: string;
  };
  agentActivity?: {
    content?: {
      body?: string;
      type?: string;
    };
  };
  agentSession?: {
    id?: string;
    promptContext?: string;
    organization?: {
      id?: string;
      urlKey?: string;
    };
    team?: {
      id?: string;
      key?: string;
      name?: string;
    };
    issue?: {
      identifier?: string;
      title?: string;
      url?: string;
      description?: string | null;
      team?: {
        id?: string;
        key?: string;
        name?: string;
      } | null;
    } | null;
  };
  promptContext?: string;
  guidance?: Array<{ body?: string; origin?: unknown }>;
};

type ActiveRunRecord = {
  agentSessionId: string;
  installationKey?: string;
  issueLabel: string;
  startedAt: number;
};

type ActiveRunStore = {
  runs: Record<string, ActiveRunRecord>;
};

const sessions = new Map<string, SessionState>();
const ACTIVE_RUNS_PATH = path.join(path.dirname(config.TOKEN_STORE_PATH), "active-runs.json");

function activeRunFallback(): ActiveRunStore {
  return { runs: {} };
}

async function readActiveRuns(): Promise<ActiveRunStore> {
  return readJsonFile<ActiveRunStore>(ACTIVE_RUNS_PATH, activeRunFallback());
}

async function markActiveRunStarted(agentSessionId: string, payload: AgentSessionWebhook, state: SessionState): Promise<void> {
  const store = await readActiveRuns();
  store.runs[agentSessionId] = {
    agentSessionId,
    installationKey: state.installationKey,
    issueLabel: issueLabel(payload),
    startedAt: Date.now(),
  };
  await writePrivateJsonFile(ACTIVE_RUNS_PATH, store);
}

async function markActiveRunFinished(agentSessionId: string): Promise<void> {
  const store = await readActiveRuns();
  if (!store.runs[agentSessionId]) return;
  delete store.runs[agentSessionId];
  await writePrivateJsonFile(ACTIVE_RUNS_PATH, store);
}

export async function recoverInterruptedSessions(): Promise<void> {
  const store = await readActiveRuns();
  const runs = Object.values(store.runs);
  if (!runs.length) return;

  await writePrivateJsonFile(ACTIVE_RUNS_PATH, activeRunFallback());

  for (const run of runs) {
    await createAgentActivity(run.agentSessionId, {
      type: "error",
      body: `Pippo restarted while working on ${run.issueLabel}; that run was interrupted. Please ask Pippo to continue and it will start a new run from the saved session context.`,
    }, { installationKey: run.installationKey }).catch((error: Error) => {
      console.error("failed to notify interrupted run", { agentSessionId: run.agentSessionId, message: error.message });
    });
  }
}

function issueLabel(payload: AgentSessionWebhook): string {
  const issue = payload.agentSession?.issue;
  return issue?.identifier ? `${issue.identifier}: ${issue.title ?? "Untitled"}` : "Linear agent session";
}

function installationKeyFromWebhook(payload: AgentSessionWebhook): string | undefined {
  return payload.organizationId ?? payload.organization?.id ?? payload.agentSession?.organization?.id;
}

function isStopPayload(payload: AgentSessionWebhook): boolean {
  const action = payload.action?.toLowerCase();
  if (action && ["cancel", "canceled", "cancelled", "stop", "stopped", "abort", "aborted"].includes(action)) {
    return true;
  }

  const body = payload.agentActivity?.content?.body?.trim().toLowerCase();
  return body === "stop" || body === "stopped" || body === "cancel" || body === "cancelled" || body === "canceled";
}

export async function handleAgentSessionWebhook(payload: AgentSessionWebhook): Promise<void> {
  const agentSessionId = payload.agentSession?.id;
  if (!agentSessionId) {
    console.warn("agent session webhook missing agentSession.id");
    return;
  }

  const state = sessions.get(agentSessionId) ?? { running: false };
  state.installationKey = installationKeyFromWebhook(payload) ?? state.installationKey;
  sessions.set(agentSessionId, state);

  const activityOptions = { installationKey: state.installationKey };

  if (isStopPayload(payload)) {
    console.log("agent session stop requested", { agentSessionId, action: payload.action, running: state.running });
    state.pendingPayload = undefined;
    state.running = false;
    const aborted = await abortPiSession(agentSessionId);
    await createAgentActivity(agentSessionId, {
      type: "error",
      body: aborted ? "Stopped by user." : "Stop requested; no active pi run was in progress.",
    }, activityOptions);
    return;
  }

  if (payload.action === "created") {
    startRun(agentSessionId, payload, state);
    return;
  }

  if (payload.action === "prompted") {
    if (state.running) {
      if (await queuePiFollowUp(agentSessionId, buildPiFollowUpPrompt(payload))) {
        await createAgentActivity(agentSessionId, {
          type: "thought",
          body: "Pi received your follow-up. It is queued in the active pi session.",
        }, activityOptions);
      } else {
        state.pendingPayload = payload;
        await createAgentActivity(agentSessionId, {
          type: "thought",
          body: "Pi received your follow-up. It will run after the current pi task finishes.",
        }, activityOptions);
      }
      return;
    }

    startRun(agentSessionId, payload, state);
  }
}

function startRun(agentSessionId: string, payload: AgentSessionWebhook, state: SessionState): void {
  if (state.running) {
    state.pendingPayload = payload;
    void createAgentActivity(agentSessionId, {
      type: "thought",
      body: "A Pi run is already active for this session; this request is queued.",
    }, { installationKey: state.installationKey }).catch((error: Error) => console.error("failed to create queued activity", { message: error.message }));
    return;
  }

  state.running = true;
  state.lastStartedAt = Date.now();

  void runSession(agentSessionId, payload, state).catch(async (error: Error) => {
    state.running = false;
    console.error("pi run crashed", { agentSessionId, message: error.message });
    await markActiveRunFinished(agentSessionId).catch((finishError: Error) => {
      console.error("failed to clear active run after crash", { agentSessionId, message: finishError.message });
    });
    await createAgentActivity(agentSessionId, {
      type: "error",
      body: `Pi failed to start or run pi: ${error.message}`,
    }, { installationKey: state.installationKey }).catch((activityError: Error) => {
      console.error("failed to create pi crash activity", { message: activityError.message });
    });
  });
}

async function runSession(agentSessionId: string, payload: AgentSessionWebhook, state: SessionState): Promise<void> {
  console.log("pi run started", { agentSessionId });
  const activityOptions = { installationKey: state.installationKey };
  await markActiveRunStarted(agentSessionId, payload, state).catch((error: Error) => {
    console.error("failed to record active run", { agentSessionId, message: error.message });
  });

  let completedRunAttempt = false;

  try {
    await createAgentActivity(agentSessionId, {
      type: "thought",
      body: `Pi received ${issueLabel(payload)} and started working.`,
    }, activityOptions).catch((error: Error) => {
      console.error("failed to create start activity", { agentSessionId, message: error.message });
    });

    const result = await runPi(payload, activityOptions);
    console.log("pi run finished", { agentSessionId, exitCode: result.exitCode, timedOut: result.timedOut });

    if (result.exitCode === 0 && !result.timedOut) {
      await createAgentActivity(agentSessionId, {
        type: "response",
        body: result.summary,
      }, activityOptions);
      console.log("linear response activity posted", { agentSessionId });

    } else {
      const reason = result.timedOut
        ? "pi timed out"
        : `pi exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`;
      await createAgentActivity(agentSessionId, {
        type: "error",
        body: `${reason}\n\n${result.summary}`,
      }, activityOptions);
      console.log("linear error activity posted", { agentSessionId, reason });
    }

    completedRunAttempt = true;
  } finally {
    await markActiveRunFinished(agentSessionId).catch((error: Error) => {
      console.error("failed to clear active run", { agentSessionId, message: error.message });
    });

    // Mark run state as not running once run attempt finishes.
    state.running = false;

    if (completedRunAttempt) {
      const pendingPayload = state.pendingPayload;
      if (pendingPayload) {
        state.pendingPayload = undefined;
        startRun(agentSessionId, pendingPayload, state);
      }
    }
  }
}
