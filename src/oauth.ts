import crypto from "node:crypto";
import { config } from "./config.js";
import { readJsonFile, writePrivateJsonFile, type StateRecord, type TokenRecord } from "./storage.js";

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const OAUTH_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];
const STATE_TTL_MS = 10 * 60 * 1000;

type StateStore = {
  states: StateRecord[];
};

type TokenStore = {
  default_installation_key?: string;
  default_app_user_id?: string;
  installations: Record<string, TokenRecord & { installed_at: number; updated_at: number }>;
};

type LinearTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string | string[];
};

type LinearGraphqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

function now() {
  return Date.now();
}

function tokenStoreFallback(): TokenStore {
  return { installations: {} };
}

async function readStateStore(): Promise<StateStore> {
  const store = await readJsonFile<StateStore>(config.STATE_STORE_PATH, { states: [] });
  const current = now();
  return { states: store.states.filter((state) => state.expires_at > current) };
}

async function writeStateStore(store: StateStore): Promise<void> {
  await writePrivateJsonFile(config.STATE_STORE_PATH, store);
}

export async function createInstallUrl(): Promise<string> {
  const state = crypto.randomBytes(32).toString("base64url");
  const current = now();
  const store = await readStateStore();

  store.states.push({
    state,
    created_at: current,
    expires_at: current + STATE_TTL_MS,
  });
  await writeStateStore(store);

  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.LINEAR_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.LINEAR_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES.join(","));
  url.searchParams.set("state", state);
  url.searchParams.set("actor", "app");
  return url.toString();
}

export async function consumeOAuthState(state: string): Promise<boolean> {
  const store = await readStateStore();
  const current = now();
  const matching = store.states.find((record) => record.state === state && record.expires_at > current);

  if (!matching) return false;

  store.states = store.states.filter((record) => record.state !== state && record.expires_at > current);
  await writeStateStore(store);
  return true;
}

async function exchangeCodeForToken(code: string): Promise<LinearTokenResponse> {
  const body = new URLSearchParams({
    code,
    redirect_uri: config.LINEAR_REDIRECT_URI,
    client_id: config.LINEAR_CLIENT_ID,
    client_secret: config.LINEAR_CLIENT_SECRET,
    grant_type: "authorization_code",
  });

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: "non_json_response" };
  }

  if (!response.ok) {
    const errorDescription =
      typeof parsed === "object" && parsed && "error_description" in parsed
        ? String((parsed as { error_description: unknown }).error_description)
        : `HTTP ${response.status}`;
    throw new Error(`Linear token exchange failed: ${errorDescription}`);
  }

  return parsed as LinearTokenResponse;
}

type LinearInstallInfo = {
  viewerAppUserId: string;
  organizationId?: string;
  organizationName?: string;
  organizationUrlKey?: string;
};

async function fetchLinearInstallInfo(accessToken: string): Promise<LinearInstallInfo> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `query Me {
        viewer {
          id
          organization { id name urlKey }
        }
      }`,
    }),
  });

  const json = (await response.json()) as LinearGraphqlResponse<{
    viewer?: {
      id?: string;
      organization?: { id?: string; name?: string; urlKey?: string } | null;
    };
  }>;

  if (!response.ok || json.errors?.length) {
    throw new Error(`Linear viewer query failed: ${json.errors?.[0]?.message ?? `HTTP ${response.status}`}`);
  }

  const viewerAppUserId = json.data?.viewer?.id;
  if (!viewerAppUserId) throw new Error("Linear viewer query did not return viewer.id");

  return {
    viewerAppUserId,
    organizationId: json.data?.viewer?.organization?.id,
    organizationName: json.data?.viewer?.organization?.name,
    organizationUrlKey: json.data?.viewer?.organization?.urlKey,
  };
}

async function saveToken(installInfo: LinearInstallInfo, token: LinearTokenResponse): Promise<void> {
  const current = now();
  const store = await readJsonFile<TokenStore>(config.TOKEN_STORE_PATH, tokenStoreFallback());
  const installationKey = installInfo.organizationId ?? installInfo.viewerAppUserId;
  const existing = store.installations[installationKey];

  store.default_installation_key = installationKey;
  store.default_app_user_id = installInfo.viewerAppUserId;
  store.installations[installationKey] = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    expires_at: current + token.expires_in * 1000,
    scope: token.scope,
    viewer_app_user_id: installInfo.viewerAppUserId,
    organization_id: installInfo.organizationId,
    organization_name: installInfo.organizationName,
    organization_url_key: installInfo.organizationUrlKey,
    installed_at: existing?.installed_at ?? current,
    updated_at: current,
  };

  await writePrivateJsonFile(config.TOKEN_STORE_PATH, store);
}

export async function completeOAuthInstall(code: string): Promise<LinearInstallInfo & { scope?: string | string[] }> {
  const token = await exchangeCodeForToken(code);
  const installInfo = await fetchLinearInstallInfo(token.access_token);
  await saveToken(installInfo, token);

  return { ...installInfo, scope: token.scope };
}
