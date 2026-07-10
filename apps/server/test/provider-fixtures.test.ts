import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentEvent, type AgentEvent as AgentEventType } from "@zuse/contracts";

import type { ThreadItem } from "@zuse/agents/codex-generated/v2/ThreadItem";
import type { ServerNotification } from "@zuse/agents/codex-generated/ServerNotification";
import {
  translateCodexItem,
  translateCodexStatusNotification,
} from "../src/provider/drivers/codex.ts";
import {
  createAcpTranslator,
  type AcpProviderTag,
} from "../src/provider/drivers/acp/translate.ts";
import { assertEventsAcceptedByMessageStore } from "./support/message-store-fixture-harness.ts";

type AcpFixture = {
  readonly fixtureVersion: 1;
  readonly provider: AcpProviderTag;
  readonly translator: "acp";
  readonly scenario: string;
  readonly source: string;
  readonly frames: ReadonlyArray<unknown>;
  readonly expectedEvents: ReadonlyArray<unknown>;
};

type CodexFixtureFrame =
  | {
      readonly kind: "item";
      readonly stage: "started" | "completed";
      readonly item: ThreadItem;
    }
  | {
      readonly kind: "status";
      readonly threadId: string;
      readonly notification: ServerNotification;
    };

type CodexFixture = {
  readonly fixtureVersion: 1;
  readonly provider: "codex";
  readonly translator: "codex";
  readonly scenario: string;
  readonly source: string;
  readonly frames: ReadonlyArray<CodexFixtureFrame>;
  readonly expectedEvents: ReadonlyArray<unknown>;
};

type NormalizedFixture = {
  readonly fixtureVersion: 1;
  readonly provider: "claude" | "opencode";
  readonly translator: "normalized-events";
  readonly scenario: string;
  readonly source: string;
  readonly frames: ReadonlyArray<unknown>;
  readonly expectedEvents: ReadonlyArray<unknown>;
};

type ProviderFixture = AcpFixture | CodexFixture | NormalizedFixture;

const fixturesRoot = fileURLToPath(
  new URL("fixtures/providers/", import.meta.url),
);
const decodeEvent = Schema.decodeUnknownSync(AgentEvent);

const loadFixtures = (): ReadonlyArray<{
  readonly path: string;
  readonly fixture: ProviderFixture;
}> => {
  const out: Array<{ path: string; fixture: ProviderFixture }> = [];
  for (const group of readdirSync(fixturesRoot)) {
    const groupDir = join(fixturesRoot, group);
    for (const file of readdirSync(groupDir).filter((name) =>
      name.endsWith(".json"),
    )) {
      const path = join(groupDir, file);
      out.push({
        path,
        fixture: JSON.parse(readFileSync(path, "utf8")) as ProviderFixture,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
};

const decodeExpectedEvents = (
  fixture: ProviderFixture,
): ReadonlyArray<AgentEventType> =>
  fixture.expectedEvents.map((event) => decodeEvent(event));

const replayFixture = (
  fixture: ProviderFixture,
): ReadonlyArray<AgentEventType> => {
  switch (fixture.translator) {
    case "acp": {
      const translator = createAcpTranslator(fixture.provider);
      return [
        ...fixture.frames.flatMap((frame) => translator.translate(frame)),
        ...translator.flush(),
      ];
    }
    case "codex":
      return fixture.frames.flatMap((frame) => {
        if (frame.kind === "item") {
          return translateCodexItem(frame.item, frame.stage);
        }
        return (
          translateCodexStatusNotification(
            frame.notification,
            frame.threadId,
          ) ?? []
        );
      });
    case "normalized-events":
      return decodeExpectedEvents(fixture);
  }
};

const alignGeneratedIds = (
  actualEvents: ReadonlyArray<AgentEventType>,
  expectedEvents: ReadonlyArray<AgentEventType>,
): ReadonlyArray<AgentEventType> =>
  actualEvents.map((event, index) => {
    const expected = expectedEvents[index] as
      | (AgentEventType & { readonly itemId?: string })
      | undefined;
    if (
      "itemId" in event &&
      typeof event.itemId === "string" &&
      event.itemId.startsWith("i_acp_") &&
      typeof expected?.itemId === "string"
    ) {
      return { ...event, itemId: expected.itemId } as AgentEventType;
    }
    if (
      event._tag === "SubagentSummary" &&
      expected?._tag === "SubagentSummary"
    ) {
      return { ...event, durationMs: expected.durationMs };
    }
    return event;
  });

const withoutUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, withoutUndefined(entry)]),
  );
};

describe("provider contract fixtures", () => {
  for (const { fixture } of loadFixtures()) {
    it(`${fixture.provider}: ${fixture.scenario}`, async () => {
      expect(fixture.fixtureVersion).toBe(1);
      expect(fixture.frames.length).toBeGreaterThan(0);
      expect(fixture.source).toContain("sanitized");

      const expectedEvents = decodeExpectedEvents(fixture);
      const actualEvents = alignGeneratedIds(
        replayFixture(fixture),
        expectedEvents,
      );

      expect(withoutUndefined(actualEvents)).toEqual(
        withoutUndefined(expectedEvents),
      );
      await assertEventsAcceptedByMessageStore(actualEvents);
    });
  }
});
