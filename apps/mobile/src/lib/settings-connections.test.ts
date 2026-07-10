import { describe, expect, test } from "vitest";

import { advancedConnections } from "./settings-connections";

describe("settings connection helpers", () => {
  test("keeps manual connections in the advanced section", () => {
    const connections = [
      {
        key: "manual",
        host: "127.0.0.1",
        port: 8787,
        label: "Local server",
        updatedAt: 1,
      },
      {
        key: "relay",
        environmentId: "env-1",
        host: "relay.example",
        port: 443,
        label: "Studio Mac",
        updatedAt: 2,
      },
    ];

    expect(advancedConnections(connections).map((connection) => connection.key)).toEqual([
      "manual",
    ]);
  });
});
