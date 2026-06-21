import { beforeEach, describe, expect, it } from "bun:test";

import type { SessionId } from "@memoize/wire";

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

const makeStorage = (): StorageLike => {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key),
    clear: () => entries.clear(),
  };
};

const localStorage = makeStorage();

Object.defineProperty(globalThis, "window", {
  value: { localStorage },
  configurable: true,
});

const { annotationsForSession, useAnnotationsStore } =
  await import("../src/store/annotations.ts");

const sessionId = "sess1" as SessionId;
const otherSessionId = "sess2" as SessionId;

describe("annotations store", () => {
  beforeEach(() => {
    localStorage.clear();
    useAnnotationsStore.setState({ bySession: {} });
  });

  it("adds annotations by session and returns a generated id", () => {
    const id = useAnnotationsStore.getState().add(sessionId, {
      relPath: "src/app.ts",
      absPath: "/repo/src/app.ts",
      startLine: 3,
      endLine: 5,
      comment: "tighten this branch",
    });

    expect(typeof id).toBe("string");
    expect(annotationsForSession(sessionId)).toEqual([
      {
        id,
        relPath: "src/app.ts",
        absPath: "/repo/src/app.ts",
        startLine: 3,
        endLine: 5,
        comment: "tighten this branch",
      },
    ]);
    expect(annotationsForSession(otherSessionId)).toEqual([]);
  });

  it("removes and clears annotations", () => {
    const first = useAnnotationsStore.getState().add(sessionId, {
      relPath: "a.ts",
      absPath: "/repo/a.ts",
      startLine: 1,
      endLine: 1,
      comment: "one",
    });
    useAnnotationsStore.getState().add(sessionId, {
      relPath: "b.ts",
      absPath: "/repo/b.ts",
      startLine: 2,
      endLine: 4,
      comment: "two",
    });

    useAnnotationsStore.getState().remove(sessionId, first);
    expect(annotationsForSession(sessionId).map((a) => a.comment)).toEqual([
      "two",
    ]);

    useAnnotationsStore.getState().clear(sessionId);
    expect(annotationsForSession(sessionId)).toEqual([]);
  });

  it("persists drafts to localStorage", () => {
    useAnnotationsStore.getState().add(sessionId, {
      relPath: "src/app.ts",
      absPath: "/repo/src/app.ts",
      startLine: 7,
      endLine: 7,
      comment: "persist me",
    });

    const raw = localStorage.getItem("memoize.annotations.v1");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "{}")).toEqual(
      useAnnotationsStore.getState().bySession,
    );
  });
});
