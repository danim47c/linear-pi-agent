import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { renderAdminPage, renderLoginPage } from "./admin-ui.js";
import { config, publicConfig } from "./config.js";
import {
  completeGitHubOAuthCallback,
  completeGitHubSetupCallback,
  createGitHubInstallUrl,
  createGitHubOAuthUrl,
  linkWorkspaceRepository,
  listGitHubInstallState,
} from "./github-installations.js";
import { listLinearInstallations, listLinearTeams, type LinearInstallationSummary } from "./linear.js";
import { completeOAuthInstall, consumeOAuthState, createInstallUrl } from "./oauth.js";
import { handleAgentSessionWebhook } from "./session-runner.js";
import { isFreshWebhookTimestamp, verifyLinearSignature } from "./signature.js";

type LinearWebhookPayload = {
  type?: string;
  action?: string;
  organizationId?: string;
  webhookTimestamp?: number;
  agentSession?: {
    id?: string;
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
      team?: {
        id?: string;
        key?: string;
        name?: string;
      };
    };
  };
};

type AdminLinearInstallation = LinearInstallationSummary & {
  workspaceKey: string;
  teams?: Array<{ id: string; key: string; name: string }>;
  teamsError?: string;
};

function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function logWebhook(payload: LinearWebhookPayload) {
  const agentActivity = (payload as { agentActivity?: { content?: { type?: string; body?: string } } }).agentActivity;
  console.log("linear webhook received", {
    type: payload.type,
    action: payload.action,
    organizationId: payload.organizationId ?? payload.agentSession?.organization?.id,
    teamId: payload.agentSession?.team?.id ?? payload.agentSession?.issue?.team?.id,
    agentSessionId: payload.agentSession?.id,
    issue: payload.agentSession?.issue?.identifier,
    activityType: agentActivity?.content?.type,
    activityBody: agentActivity?.content?.body?.slice(0, 120),
  });
}

function handleAgentSessionEvent(payload: LinearWebhookPayload) {
  void handleAgentSessionWebhook(payload).catch((error: Error) => {
    console.error("failed to handle agent session webhook", { message: error.message });
  });
}

const ADMIN_COOKIE_NAME = "pippo_admin";
const ADMIN_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

function installSecretFromRequest(req: Request): string | undefined {
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return typeof req.query.install_secret === "string" ? req.query.install_secret : undefined;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isInstallSecretAuthorized(provided: string | undefined): boolean {
  if (!config.INSTALL_SECRET) return true;
  if (!provided) return false;
  return timingSafeStringEqual(provided, config.INSTALL_SECRET);
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.get("cookie");
  if (!header) return {};
  return Object.fromEntries(header.split(";").flatMap((entry) => {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (!rawName) return [];
    return [[rawName, decodeURIComponent(rawValue.join("="))]];
  }));
}

function adminCookieSignature(expiresAt: number): string {
  return crypto
    .createHmac("sha256", config.INSTALL_SECRET ?? "pippo-dev")
    .update(String(expiresAt))
    .digest("base64url");
}

function createAdminCookie(): string {
  const expiresAt = Date.now() + ADMIN_COOKIE_MAX_AGE_SECONDS * 1000;
  return `${expiresAt}.${adminCookieSignature(expiresAt)}`;
}

function isAdminCookieAuthorized(req: Request): boolean {
  if (!config.INSTALL_SECRET) return true;
  const cookie = parseCookies(req)[ADMIN_COOKIE_NAME];
  if (!cookie) return false;
  const [expiresText, signature] = cookie.split(".");
  const expiresAt = Number(expiresText);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !signature) return false;
  return timingSafeStringEqual(signature, adminCookieSignature(expiresAt));
}

function adminCookieHeader(value: string, maxAgeSeconds = ADMIN_COOKIE_MAX_AGE_SECONDS): string {
  const secure = config.BASE_URL.startsWith("https://") ? "; Secure" : "";
  return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function isInstallAuthorized(req: Request): boolean {
  return isAdminCookieAuthorized(req) || isInstallSecretAuthorized(installSecretFromRequest(req));
}

function requireInstallAuthorized(req: Request, res: Response): boolean {
  if (isInstallAuthorized(req)) return true;
  res.status(401).type("text/plain").send("Missing or invalid install secret.\n");
  return false;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredNumber(value: unknown, label: string): number {
  const text = optionalString(value);
  const parsed = text ? Number(text) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

async function inferWorkspaceKey(candidate?: string): Promise<string> {
  if (candidate) return candidate;

  const installs = await listLinearInstallations();
  if (installs.length === 1) {
    return installs[0].organizationId ?? installs[0].organizationUrlKey ?? installs[0].key;
  }

  throw new Error("Specify workspace=<linear organization id/urlKey>; it could not be inferred.");
}

async function inferRepository(candidate?: string): Promise<string> {
  if (candidate) return candidate;

  const state = await listGitHubInstallState();
  if (state.repositories.length === 1) return state.repositories[0].fullName;
  throw new Error("Specify repo=owner/repo; it could not be inferred.");
}

function workspaceKey(installation: LinearInstallationSummary): string {
  return installation.organizationId ?? installation.organizationUrlKey ?? installation.key;
}

async function linearInstallationsForAdmin(): Promise<AdminLinearInstallation[]> {
  const installations = await listLinearInstallations();
  return Promise.all(installations.map(async (installation) => {
    const key = workspaceKey(installation);
    try {
      return { ...installation, workspaceKey: key, teams: await listLinearTeams(installation.key) };
    } catch (error) {
      return {
        ...installation,
        workspaceKey: key,
        teams: [],
        teamsError: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

function parseScope(value: string | undefined): { workspaceKey?: string; teamKey?: string } {
  if (!value) return {};
  const [workspace, team] = value.split("|", 2);
  return { workspaceKey: optionalString(workspace), teamKey: optionalString(team) };
}

async function renderAdmin(req: Request, res: Response, overrides: { notice?: string; error?: string } = {}) {
  if (!isInstallAuthorized(req)) return res.redirect(302, "/admin/login");
  const [linearInstallations, github] = await Promise.all([linearInstallationsForAdmin(), listGitHubInstallState()]);
  return res.type("html").send(renderAdminPage({ linearInstallations, github, ...overrides }));
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "linear-pi-agent" });
  });

  app.get(["/", "/admin"], async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      await renderAdmin(req, res, { notice: optionalString(req.query.notice), error: optionalString(req.query.error) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/admin/login", (req: Request, res: Response) => {
    if (isInstallAuthorized(req)) return res.redirect(302, "/admin");
    return res.type("html").send(renderLoginPage(optionalString(req.query.error)));
  });

  app.post("/admin/login", (req: Request, res: Response) => {
    if (!isInstallSecretAuthorized(optionalString(req.body?.install_secret))) {
      return res.status(401).type("html").send(renderLoginPage("Invalid install secret."));
    }

    res.setHeader("Set-Cookie", adminCookieHeader(createAdminCookie()));
    return res.redirect(302, "/admin");
  });

  app.get("/admin/logout", (_req: Request, res: Response) => {
    res.setHeader("Set-Cookie", adminCookieHeader("", 0));
    return res.redirect(302, "/admin/login");
  });

  app.post("/admin/link", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (!isInstallAuthorized(req)) return res.redirect(302, "/admin/login");
      const scope = parseScope(optionalString(req.body?.scope));
      const workspaceKey = await inferWorkspaceKey(scope.workspaceKey);
      const repository = await inferRepository(optionalString(req.body?.repo));
      const link = await linkWorkspaceRepository(workspaceKey, repository, scope.teamKey);
      await renderAdmin(req, res, {
        notice: `Linked ${link.teamKey ? `team ${link.teamKey}` : `workspace ${link.workspaceKey}`} to ${link.defaultRepository}.`,
      });
    } catch (error) {
      await renderAdmin(req, res, { error: error instanceof Error ? error.message : String(error) }).catch(() => next(error));
    }
  });

  app.get("/linear/install", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (!isInstallAuthorized(req)) {
        return res.status(401).type("text/plain").send("Missing or invalid install secret.\n");
      }

      const installUrl = await createInstallUrl();
      res.redirect(302, installUrl);
    } catch (error) {
      next(error);
    }
  });

  app.get("/linear/oauth/callback", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (typeof req.query.error === "string") {
        return res.status(400).send(`Linear OAuth error: ${req.query.error}\n`);
      }

      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;

      if (!code || !state) {
        return res.status(400).send("Missing OAuth code or state.\n");
      }

      if (!(await consumeOAuthState(state))) {
        return res.status(401).send("Invalid or expired OAuth state.\n");
      }

      const install = await completeOAuthInstall(code);
      console.log("linear app installed", {
        viewerAppUserId: install.viewerAppUserId,
        scope: install.scope,
      });

      return res.type("text/plain").send(
        [
          "Pi is installed in Linear.",
          `Workspace: ${install.organizationName ?? install.organizationId ?? "unknown"}`,
          `App user ID: ${install.viewerAppUserId}`,
          "You can close this tab.",
          "",
        ].join("\n"),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/github/status", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (!requireInstallAuthorized(req, res)) return;
      const [linear, github] = await Promise.all([listLinearInstallations(), listGitHubInstallState()]);
      res.json({ ok: true, linearInstallations: linear, github });
    } catch (error) {
      next(error);
    }
  });

  app.get("/github/install", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (!requireInstallAuthorized(req, res)) return;
      const installUrl = await createGitHubInstallUrl({
        workspaceKey: optionalString(req.query.workspace),
        defaultRepository: optionalString(req.query.repo),
      });
      res.redirect(302, installUrl);
    } catch (error) {
      next(error);
    }
  });

  app.get("/github/setup/callback", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      const installation = await completeGitHubSetupCallback({
        installationId: requiredNumber(req.query.installation_id, "installation_id"),
        state: optionalString(req.query.state),
        setupAction: optionalString(req.query.setup_action),
      });

      console.log("github app installation updated", {
        installationId: installation.installation.id,
        account: installation.installation.accountLogin,
        repositoryCount: installation.installation.repositories.length,
        linkedWorkspace: installation.linked?.workspaceKey,
      });

      return res.type("text/plain").send(
        [
          "Pippo GitHub App installation saved.",
          `Account: ${installation.installation.accountLogin ?? "unknown"}`,
          `Installation ID: ${installation.installation.id}`,
          `Repositories: ${installation.installation.repositories.length}`,
          installation.linked ? `Linked workspace: ${installation.linked.workspaceKey} -> ${installation.linked.defaultRepository}` : undefined,
          "",
          "You can close this tab.",
          "",
        ].filter(Boolean).join("\n"),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/github/oauth/start", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (!requireInstallAuthorized(req, res)) return;
      const oauthUrl = await createGitHubOAuthUrl({
        workspaceKey: optionalString(req.query.workspace),
        defaultRepository: optionalString(req.query.repo),
      });
      res.redirect(302, oauthUrl);
    } catch (error) {
      next(error);
    }
  });

  app.get("/github/oauth/callback", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (typeof req.query.error === "string") {
        return res.status(400).send(`GitHub OAuth error: ${req.query.error}\n`);
      }

      const code = optionalString(req.query.code);
      if (!code) return res.status(400).send("Missing GitHub OAuth code.\n");

      const user = await completeGitHubOAuthCallback({ code, state: optionalString(req.query.state) });
      console.log("github oauth user authorized", { login: user.login, id: user.id });
      return res.type("text/plain").send(
        [
          "GitHub user authorization saved.",
          `GitHub user: ${user.login}`,
          "Pippo does not persist the OAuth access token; repository access uses GitHub App installation tokens.",
          "You can close this tab.",
          "",
        ].join("\n"),
      );
    } catch (error) {
      next(error);
    }
  });

  app.all("/github/link", async (req: Request, res: Response, next: express.NextFunction) => {
    try {
      if (!requireInstallAuthorized(req, res)) return;
      const workspaceKey = await inferWorkspaceKey(optionalString(req.query.workspace) ?? optionalString(req.body?.workspace));
      const teamKey = optionalString(req.query.team) ?? optionalString(req.body?.team);
      const repository = await inferRepository(optionalString(req.query.repo) ?? optionalString(req.body?.repo));
      const link = await linkWorkspaceRepository(workspaceKey, repository, teamKey);
      res.json({ ok: true, link });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/linear/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    (req: Request, res: Response) => {
      const body = rawBody(req);

      if (!verifyLinearSignature(req.get("linear-signature"), body)) {
        return res.status(401).json({ ok: false, error: "invalid_signature" });
      }

      let payload: LinearWebhookPayload;
      try {
        payload = parseJsonBody(body) as LinearWebhookPayload;
      } catch {
        return res.status(400).json({ ok: false, error: "invalid_json" });
      }

      if (!isFreshWebhookTimestamp(payload.webhookTimestamp)) {
        return res.status(401).json({ ok: false, error: "stale_webhook" });
      }

      logWebhook(payload);
      if (payload.type === "AgentSessionEvent") {
        handleAgentSessionEvent(payload);
      }

      return res.status(200).json({ ok: true, accepted: payload.type === "AgentSessionEvent" });
    },
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: "not_found" });
  });

  app.use((error: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error("request failed", { name: error.name, message: error.message });
    res.status(500).json({ ok: false, error: "internal_error" });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = createApp();
  app.listen(config.PORT, config.HOST, () => {
    console.log("linear pi agent listening", publicConfig());
  });
}
