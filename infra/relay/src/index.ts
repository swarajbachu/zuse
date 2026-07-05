export type ProviderKind = "desktop" | "ssh" | "cloud";

export type EnvironmentEndpoint = {
  httpBaseUrl: string;
  wsBaseUrl: string;
};

export type EnvironmentRecord = {
  environmentId: string;
  providerKind: ProviderKind;
  endpoint: EnvironmentEndpoint;
  label?: string;
  tunnelHostname?: string;
  linkedAt: number;
};

export type DeviceRecord = {
  deviceId: string;
  platform: "ios" | "android" | "web";
  pushToken?: string;
  dpopJwk?: unknown;
  updatedAt: number;
};

export type LinkChallenge = {
  challengeId: string;
  challenge: string;
  relayIssuer: string;
  expiresAt: number;
};

export interface RelayStore {
  createChallenge(challenge: LinkChallenge): Promise<void>;
  consumeChallenge(challengeId: string): Promise<LinkChallenge | null>;
  upsertEnvironment(environment: EnvironmentRecord): Promise<void>;
  listEnvironments(): Promise<EnvironmentRecord[]>;
  getEnvironment(environmentId: string): Promise<EnvironmentRecord | null>;
  upsertDevice(device: DeviceRecord): Promise<void>;
  listDevices(): Promise<DeviceRecord[]>;
  recordActivity(activity: AgentActivity): Promise<void>;
}

export type AgentActivity = {
  environmentId: string;
  sessionId: string;
  kind:
    | "approval-needed"
    | "question-needed"
    | "completed"
    | "error"
    | "running";
  title?: string;
  occurredAt: number;
};

export type RelayOptions = {
  issuer: string;
  now?: () => number;
  tokenTtlMs?: number;
};

export const createMemoryStore = (): RelayStore => {
  const challenges = new Map<string, LinkChallenge>();
  const environments = new Map<string, EnvironmentRecord>();
  const devices = new Map<string, DeviceRecord>();
  const activities: AgentActivity[] = [];

  return {
    createChallenge: async (challenge) => {
      challenges.set(challenge.challengeId, challenge);
    },
    consumeChallenge: async (challengeId) => {
      const challenge = challenges.get(challengeId) ?? null;
      challenges.delete(challengeId);
      return challenge;
    },
    upsertEnvironment: async (environment) => {
      environments.set(environment.environmentId, environment);
    },
    listEnvironments: async () => [...environments.values()],
    getEnvironment: async (environmentId) =>
      environments.get(environmentId) ?? null,
    upsertDevice: async (device) => {
      devices.set(device.deviceId, device);
    },
    listDevices: async () => [...devices.values()],
    recordActivity: async (activity) => {
      activities.push(activity);
    },
  };
};

export const createRelayHandler = (
  store: RelayStore,
  options: RelayOptions,
) => {
  const now = options.now ?? Date.now;
  const tokenTtlMs = options.tokenTtlMs ?? 5 * 60 * 1000;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (
      method === "POST" &&
      url.pathname === "/v1/client/environment-link-challenges"
    ) {
      const challenge = makeId("chl");
      const body: LinkChallenge = {
        challengeId: makeId("challenge"),
        challenge,
        relayIssuer: options.issuer,
        expiresAt: now() + tokenTtlMs,
      };
      await store.createChallenge(body);
      return json(body);
    }

    if (method === "POST" && url.pathname === "/v1/client/environment-links") {
      const body = await request.json() as Partial<EnvironmentRecord> & {
        challengeId?: string;
        proof?: string;
      };
      if (!body.challengeId || !body.proof?.startsWith("zlp_")) {
        return json({ error: "invalid_link_proof" }, 401);
      }
      const challenge = await store.consumeChallenge(body.challengeId);
      if (challenge === null || challenge.expiresAt <= now()) {
        return json({ error: "expired_challenge" }, 410);
      }
      if (
        !body.environmentId ||
        !isProviderKind(body.providerKind) ||
        !isEndpoint(body.endpoint)
      ) {
        return json({ error: "invalid_environment" }, 400);
      }
      const environment: EnvironmentRecord = {
        environmentId: body.environmentId,
        providerKind: body.providerKind,
        endpoint: body.endpoint,
        label: body.label,
        tunnelHostname: body.tunnelHostname,
        linkedAt: now(),
      };
      await store.upsertEnvironment(environment);
      return json(environment);
    }

    if (method === "GET" && url.pathname === "/v1/environments") {
      return json({ environments: await store.listEnvironments() });
    }

    const connectMatch = /^\/v1\/environments\/([^/]+)\/connect$/.exec(
      url.pathname,
    );
    if (method === "POST" && connectMatch !== null) {
      const environmentId = decodeURIComponent(connectMatch[1]!);
      const environment = await store.getEnvironment(environmentId);
      if (environment === null) return json({ error: "not_found" }, 404);
      const endpoint =
        environment.tunnelHostname !== undefined
          ? {
              httpBaseUrl: `https://${environment.tunnelHostname}`,
              wsBaseUrl: `wss://${environment.tunnelHostname}/rpc`,
            }
          : environment.endpoint;
      return json({
        environment,
        endpoint,
        connectToken: issueConnectToken(environmentId, now() + tokenTtlMs),
        expiresAt: now() + tokenTtlMs,
      });
    }

    if (method === "POST" && url.pathname === "/v1/mobile/devices") {
      const body = await request.json() as Partial<DeviceRecord>;
      if (
        !body.deviceId ||
        (body.platform !== "ios" &&
          body.platform !== "android" &&
          body.platform !== "web")
      ) {
        return json({ error: "invalid_device" }, 400);
      }
      const device: DeviceRecord = {
        deviceId: body.deviceId,
        platform: body.platform,
        pushToken: body.pushToken,
        dpopJwk: body.dpopJwk,
        updatedAt: now(),
      };
      await store.upsertDevice(device);
      return json(device);
    }

    const activityMatch = /^\/v1\/environments\/([^/]+)\/agent-activity$/.exec(
      url.pathname,
    );
    if (method === "POST" && activityMatch !== null) {
      const environmentId = decodeURIComponent(activityMatch[1]!);
      const body = await request.json() as Partial<AgentActivity> & {
        messages?: unknown;
        chatBytes?: unknown;
      };
      if (body.messages !== undefined || body.chatBytes !== undefined) {
        return json({ error: "chat_data_not_allowed" }, 400);
      }
      if (!body.sessionId || !isActivityKind(body.kind)) {
        return json({ error: "invalid_activity" }, 400);
      }
      const activity: AgentActivity = {
        environmentId,
        sessionId: body.sessionId,
        kind: body.kind,
        title: body.title,
        occurredAt: now(),
      };
      await store.recordActivity(activity);
      const devices = await store.listDevices();
      return json({ delivered: devices.filter((d) => d.pushToken).length });
    }

    return json({ error: "not_found" }, 404);
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const issueConnectToken = (environmentId: string, expiresAt: number): string =>
  `zct_${btoa(JSON.stringify({ environmentId, expiresAt }))}`;

const isProviderKind = (value: unknown): value is ProviderKind =>
  value === "desktop" || value === "ssh" || value === "cloud";

const isEndpoint = (value: unknown): value is EnvironmentEndpoint => {
  const endpoint = value as Partial<EnvironmentEndpoint> | undefined;
  return (
    typeof endpoint?.httpBaseUrl === "string" &&
    typeof endpoint.wsBaseUrl === "string"
  );
};

const isActivityKind = (value: unknown): value is AgentActivity["kind"] =>
  value === "approval-needed" ||
  value === "question-needed" ||
  value === "completed" ||
  value === "error" ||
  value === "running";
