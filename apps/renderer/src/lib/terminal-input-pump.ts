export type TerminalInputFailure = "write-failed" | "write-timeout";

export interface TerminalInputPump {
  readonly failed: boolean;
  enqueue(data: string): void;
  dispose(): void;
  whenIdle(): Promise<void>;
}

export function createTerminalInputPump(options: {
  readonly write: (data: string) => Promise<void>;
  readonly timeoutMs: number;
  readonly onFailure: (reason: TerminalInputFailure, cause?: unknown) => void;
  readonly onQueueHighWater?: (characters: number) => void;
}): TerminalInputPump {
  let queued = "";
  let writing = false;
  let disposed = false;
  let failed = false;
  let highWater = 0;
  let idleWaiters: Array<() => void> = [];

  const resolveIdle = (): void => {
    if (writing || queued.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const fail = (reason: TerminalInputFailure, cause?: unknown): void => {
    if (disposed || failed) return;
    failed = true;
    queued = "";
    options.onFailure(reason, cause);
  };

  const writeWithTimeout = (data: string): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("terminal input acknowledgement timed out"));
      }, options.timeoutMs);
      void options.write(data).then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (cause) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(cause);
        },
      );
    });

  const drain = async (): Promise<void> => {
    if (writing || disposed || failed || queued.length === 0) return;
    writing = true;
    const data = queued;
    queued = "";
    try {
      await writeWithTimeout(data);
    } catch (cause) {
      fail(
        cause instanceof Error &&
          cause.message === "terminal input acknowledgement timed out"
          ? "write-timeout"
          : "write-failed",
        cause,
      );
    } finally {
      writing = false;
      if (!disposed && !failed && queued.length > 0) void drain();
      else resolveIdle();
    }
  };

  return {
    get failed() {
      return failed;
    },
    enqueue(data) {
      if (disposed || failed || data.length === 0) return;
      queued += data;
      if (queued.length > highWater) {
        highWater = queued.length;
        options.onQueueHighWater?.(highWater);
      }
      void drain();
    },
    dispose() {
      disposed = true;
      queued = "";
      resolveIdle();
    },
    whenIdle() {
      if (!writing && queued.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
