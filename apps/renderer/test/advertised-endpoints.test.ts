import { describe, expect, it } from "vitest";

import type { AdvertisedEndpoint } from "@zuse/contracts";

import { selectAdvertisedEndpoint } from "../src/lib/advertised-endpoints.ts";

const endpoint = (
  input: Partial<AdvertisedEndpoint> &
    Pick<AdvertisedEndpoint, "id" | "reachability">,
): AdvertisedEndpoint =>
  ({
    label: input.id,
    providerKind: "core",
    httpBaseUrl:
      input.reachability === "tunnel"
        ? `https://${input.id}.example.test`
        : `http://${input.id}.example.test`,
    wsBaseUrl:
      input.reachability === "tunnel"
        ? `wss://${input.id}.example.test/rpc`
        : `ws://${input.id}.example.test`,
    compatibility: {
      hostedHttpsApp:
        input.reachability === "tunnel"
          ? "compatible"
          : "mixed-content-blocked",
    },
    status: "available",
    isDefault: false,
    ...input,
  }) as AdvertisedEndpoint;

describe("selectAdvertisedEndpoint", () => {
  it("uses a valid user override by stable endpoint id", () => {
    const endpoints = [
      endpoint({ id: "core:lan", reachability: "lan" }),
      endpoint({
        id: "tunnel:managed-relay",
        reachability: "tunnel",
        isDefault: true,
      }),
    ];

    expect(selectAdvertisedEndpoint(endpoints, "core:lan")?.id).toBe(
      "core:lan",
    );
  });

  it("ignores stale overrides and falls back to the server default", () => {
    const endpoints = [
      endpoint({ id: "core:lan", reachability: "lan" }),
      endpoint({
        id: "tunnel:managed-relay",
        reachability: "tunnel",
        isDefault: true,
      }),
    ];

    expect(selectAdvertisedEndpoint(endpoints, "missing")?.id).toBe(
      "tunnel:managed-relay",
    );
  });

  it("prefers hosted HTTPS compatible endpoints without server default", () => {
    const endpoints = [
      endpoint({ id: "core:loopback", reachability: "loopback" }),
      endpoint({ id: "core:lan", reachability: "lan" }),
      endpoint({ id: "tunnel:managed-relay", reachability: "tunnel" }),
    ];

    expect(selectAdvertisedEndpoint(endpoints, null)?.id).toBe(
      "tunnel:managed-relay",
    );
  });
});
