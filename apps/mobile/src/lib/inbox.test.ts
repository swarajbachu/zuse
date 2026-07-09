import { describe, expect, test } from "bun:test";

import {
  buildInboxGroups,
  buildInboxListItems,
  DEFAULT_INBOX_GROUP_DISPLAY,
  nextInboxGroupDisplay,
  relativeTimeLabel,
} from "./inbox";

const connection = {
  key: "env-1",
  environmentId: "env-1",
  host: "relay.example",
  port: 443,
  label: "Studio Mac",
  updatedAt: 1,
};

const project = {
  id: "project-1",
  name: "Davao",
  path: "/Users/example/davao",
  addedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const session = (input: Partial<Record<string, unknown>> = {}) => ({
  id: input.id ?? "session-1",
  projectId: project.id,
  title: input.title ?? "Build mobile UI",
  providerId: input.providerId ?? "codex",
  model: input.model ?? "gpt-5",
  status: input.status ?? "idle",
  archivedAt: null,
  cursor: null,
  resumeStrategy: "none",
  runtimeMode: "default",
  worktreeId: null,
  chatId: input.chatId ?? "chat-1",
  forkedFromSessionId: null,
  forkedFromMessageId: null,
});

const chat = (input: Partial<Record<string, unknown>> = {}) => ({
  id: input.id ?? "chat-1",
  projectId: project.id,
  worktreeId: null,
  title: input.title ?? "Mobile polish",
  activeSessionId: input.activeSessionId ?? "session-1",
  archivedAt: null,
  lastMessageAt: input.lastMessageAt ?? new Date("2026-01-02T00:00:00.000Z"),
  lastReadAt: input.lastReadAt ?? new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: input.updatedAt ?? new Date("2026-01-02T00:00:00.000Z"),
});

describe("mobile inbox helpers", () => {
  test("groups chats by project and prioritizes running unread rows", () => {
    const groups = buildInboxGroups({
      connections: [connection],
      bundlesByConnection: {
        "env-1": [
          {
            project,
            chats: [
              chat({ id: "chat-old", title: "Older read", activeSessionId: "session-old" }),
              chat({ id: "chat-run", title: "Running unread", activeSessionId: "session-run" }),
            ] as never,
            sessions: [
              session({ id: "session-old", chatId: "chat-old", status: "idle" }),
              session({ id: "session-run", chatId: "chat-run", status: "idle" }),
            ] as never,
          },
        ],
      },
      statusBySession: { [JSON.stringify(["env-1", "session-run"])]: "running" },
      query: "",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("Davao");
    expect(groups[0]?.activeCount).toBe(1);
    expect(groups[0]?.unreadCount).toBe(2);
    expect(groups[0]?.rows[0]?.title).toBe("Running unread");
  });

  test("filters by project, source, model, and chat title", () => {
    const groups = buildInboxGroups({
      connections: [connection],
      bundlesByConnection: {
        "env-1": [
          {
            project,
            chats: [chat({ title: "Release checklist" })] as never,
            sessions: [session({ model: "gpt-5" })] as never,
          },
        ],
      },
      statusBySession: {},
      query: "studio",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows[0]?.title).toBe("Release checklist");
  });

  test("keeps provider/model searchable but off the visible subtitle", () => {
    const build = (query: string) =>
      buildInboxGroups({
        connections: [connection],
        bundlesByConnection: {
          "env-1": [
            {
              project,
              chats: [chat({ title: "Release checklist" })] as never,
              sessions: [session({ providerId: "codex", model: "gpt-5" })] as never,
            },
          ],
        },
        statusBySession: {},
        query,
      });

    // Search still matches provider/model even though the subtitle now shows time.
    expect(build("codex")).toHaveLength(1);
    const row = build("")[0]?.rows[0];
    expect(row?.providerModel).toBe("codex / gpt-5");
    expect(row?.subtitle).not.toContain("/");
    expect(row?.subtitle).not.toContain("codex");
  });

  test("relativeTimeLabel formats across boundaries", () => {
    const now = new Date("2026-07-09T12:00:00.000Z").getTime();
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    expect(relativeTimeLabel(0, now)).toBe("");
    expect(relativeTimeLabel(now - 30 * 1000, now)).toBe("now");
    expect(relativeTimeLabel(now - 2 * minute, now)).toBe("2m");
    expect(relativeTimeLabel(now - 3 * hour, now)).toBe("3h");
    // 2 days ago is within the week → a weekday label.
    expect(relativeTimeLabel(now - 2 * day, now)).toMatch(
      /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/,
    );
    // Older than a week → a short date.
    expect(relativeTimeLabel(now - 40 * day, now)).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}$/,
    );
  });

  test("builds collapsible show-more list items", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      ...chat({ id: `chat-${index}`, title: `Chat ${index}` }),
      activeSessionId: `session-${index}`,
    }));
    const groups = buildInboxGroups({
      connections: [connection],
      bundlesByConnection: {
        "env-1": [
          {
            project,
            chats: rows as never,
            sessions: rows.map((item, index) =>
              session({ id: `session-${index}`, chatId: item.id }),
            ) as never,
          },
        ],
      },
      statusBySession: {},
      query: "",
    });

    const listItems = buildInboxListItems({
      groups,
      displayStates: new Map(),
      searching: false,
    });
    expect(listItems.filter((item) => item.type === "chat")).toHaveLength(6);
    expect(listItems.at(-1)?.type).toBe("show-more");

    const expanded = nextInboxGroupDisplay(DEFAULT_INBOX_GROUP_DISPLAY, "show-more");
    const expandedItems = buildInboxListItems({
      groups,
      displayStates: new Map([[groups[0]!.key, expanded]]),
      searching: false,
    });
    expect(expandedItems.filter((item) => item.type === "chat")).toHaveLength(8);
  });
});
