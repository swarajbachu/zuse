import type { RpcClient, RpcGroup } from "@effect/rpc";
import type { MemoizeRpcs } from "@zuse/wire";
import { Effect } from "effect";

import { ConnectionFailed } from "./errors";
import type { WsProtocolOptions } from "./ws-protocol";

export type MemoizeClient = RpcClient.RpcClient<RpcGroup.Rpcs<typeof MemoizeRpcs>>;

export type ConnectionStatus =
  | "offline"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "blockedAuth";

export type ConnectionSnapshot = {
  readonly key: string;
  readonly status: ConnectionStatus;
  readonly generation: number;
  readonly attempt: number;
  readonly error: string | null;
};

export type ConnectionEvents = {
  readonly onChange?: (snapshot: ConnectionSnapshot) => void;
};

export type SupervisorEntry = {
  readonly getClient: () => Effect.Effect<MemoizeClient, ConnectionFailed>;
  readonly reportFailure: (cause: unknown) => void;
  readonly retryNow: () => void;
  readonly remove: () => Promise<void>;
  readonly snapshot: () => ConnectionSnapshot;
  readonly subscribe: (listener: (snapshot: ConnectionSnapshot) => void) => () => void;
};

export type ConnectionSupervisorDeps = {
  readonly keyOf: (options: WsProtocolOptions) => string;
  readonly prepareOptions: (options: WsProtocolOptions) => Promise<WsProtocolOptions>;
  readonly createClient: (options: WsProtocolOptions) => Promise<{
    readonly client: MemoizeClient;
    readonly dispose: () => Promise<void>;
  }>;
  readonly isOnline: () => boolean;
  readonly schedule: (delayMs: number, fn: () => void) => () => void;
  readonly classifyError?: (cause: unknown) => "auth" | "transient";
};

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const defaultClassifyError = (cause: unknown): "auth" | "transient" => {
  const message = messageOf(cause).toLowerCase();
  return message.includes("401") ||
    message.includes("403") ||
    message.includes("auth") ||
    message.includes("unauthorized") ||
    message.includes("forbidden")
    ? "auth"
    : "transient";
};

export const createConnectionSupervisor = (deps: ConnectionSupervisorDeps) => {
  const entries = new Map<string, SupervisorEntryImpl>();

  const get = (options: WsProtocolOptions): SupervisorEntry => {
    const key = deps.keyOf(options);
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = new SupervisorEntryImpl(key, options, deps, () => entries.delete(key));
      entries.set(key, entry);
    } else {
      entry.updateOptions(options);
    }
    return entry;
  };

  const setOnline = (online: boolean) => {
    for (const entry of entries.values()) {
      entry.setOnline(online);
    }
  };

  const snapshots = (): readonly ConnectionSnapshot[] =>
    [...entries.values()].map((entry) => entry.snapshot());

  return { get, setOnline, snapshots };
};

class SupervisorEntryImpl implements SupervisorEntry {
  private options: WsProtocolOptions;
  private client: MemoizeClient | null = null;
  private disposeClient: (() => Promise<void>) | null = null;
  private inFlight: Promise<MemoizeClient> | null = null;
  private retryCancel: (() => void) | null = null;
  private listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private state: ConnectionSnapshot;

  constructor(
    private readonly key: string,
    options: WsProtocolOptions,
    private readonly deps: ConnectionSupervisorDeps,
    private readonly onRemove: () => void,
  ) {
    this.options = options;
    this.state = {
      key,
      status: deps.isOnline() ? "connecting" : "offline",
      generation: 0,
      attempt: 0,
      error: null,
    };
  }

  updateOptions(options: WsProtocolOptions): void {
    this.options = options;
  }

  snapshot(): ConnectionSnapshot {
    return this.state;
  }

  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getClient(): Effect.Effect<MemoizeClient, ConnectionFailed> {
    return Effect.tryPromise({
      try: () => this.ensureClient(),
      catch: (cause) =>
        new ConnectionFailed({
          message: messageOf(cause),
        }),
    });
  }

  reportFailure(cause: unknown): void {
    void this.closeCurrent();
    this.inFlight = null;
    this.markFailure(cause);
  }

  retryNow(): void {
    this.clearRetry();
    if (!this.deps.isOnline()) {
      this.emit({ status: "offline", error: null });
      return;
    }
    void this.closeCurrent();
    this.inFlight = null;
    void this.ensureClient().catch(() => {});
  }

  setOnline(online: boolean): void {
    if (!online) {
      this.clearRetry();
      void this.closeCurrent();
      this.inFlight = null;
      this.emit({ status: "offline", error: null });
      return;
    }
    if (this.state.status === "offline") {
      this.emit({ status: "reconnecting", error: null });
      this.retryNow();
    }
  }

  async remove(): Promise<void> {
    this.clearRetry();
    await this.closeCurrent();
    this.inFlight = null;
    this.listeners.clear();
    this.onRemove();
  }

  private async ensureClient(): Promise<MemoizeClient> {
    if (!this.deps.isOnline()) {
      this.emit({ status: "offline", error: null });
      throw new Error("offline");
    }
    if (this.client !== null) return this.client;
    if (this.inFlight !== null) return this.inFlight;

    this.clearRetry();
    this.emit({
      status: this.state.generation === 0 ? "connecting" : "reconnecting",
      error: null,
    });

    this.inFlight = this.connectOnce();
    try {
      const client = await this.inFlight;
      this.client = client;
      this.inFlight = null;
      this.emit({
        status: "connected",
        generation: this.state.generation + 1,
        attempt: 0,
        error: null,
      });
      return client;
    } catch (cause) {
      this.inFlight = null;
      this.markFailure(cause);
      throw cause;
    }
  }

  private async connectOnce(): Promise<MemoizeClient> {
    const prepared = await this.deps.prepareOptions(this.options);
    this.options = prepared;
    const session = await this.deps.createClient(prepared);
    this.disposeClient = session.dispose;
    try {
      await Effect.runPromise(session.client.connect.describe());
      return session.client;
    } catch (cause) {
      await session.dispose().catch(() => {});
      this.disposeClient = null;
      throw cause;
    }
  }

  private markFailure(cause: unknown): void {
    if (!this.deps.isOnline()) {
      this.emit({ status: "offline", error: null });
      return;
    }
    const classify = this.deps.classifyError ?? defaultClassifyError;
    if (classify(cause) === "auth") {
      this.emit({ status: "blockedAuth", error: messageOf(cause) });
      return;
    }
    const attempt = this.state.attempt + 1;
    this.emit({ status: "reconnecting", attempt, error: messageOf(cause) });
    const delay = Math.min(
      MAX_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
    );
    this.retryCancel = this.deps.schedule(delay, () => {
      this.retryCancel = null;
      void this.ensureClient().catch(() => {});
    });
  }

  private async closeCurrent(): Promise<void> {
    const dispose = this.disposeClient;
    this.client = null;
    this.disposeClient = null;
    if (dispose !== null) {
      await dispose().catch(() => {});
    }
  }

  private clearRetry(): void {
    if (this.retryCancel !== null) {
      this.retryCancel();
      this.retryCancel = null;
    }
  }

  private emit(patch: Partial<Omit<ConnectionSnapshot, "key">>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
