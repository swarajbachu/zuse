import { describe, expect, test } from "vitest";

import {
  acceptedWorkosIssuers,
  expectedWorkosClientId,
  isAcceptedWorkosIssuer,
} from "../src/workos.ts";

describe("acceptedWorkosIssuers", () => {
  test("accepts WorkOS issuer with and without trailing slash", () => {
    expect(acceptedWorkosIssuers("https://api.workos.com")).toEqual([
      "https://api.workos.com",
      "https://api.workos.com/",
    ]);
    expect(acceptedWorkosIssuers("https://api.workos.com/")).toEqual([
      "https://api.workos.com",
      "https://api.workos.com/",
    ]);
  });

  test("accepts WorkOS User Management token issuers", () => {
    expect(
      isAcceptedWorkosIssuer(
        "https://api.workos.com/user_management/client_01KW6ZF0389TC20FTQHK4VP8KA",
        "https://api.workos.com",
      ),
    ).toBe(true);
    expect(
      isAcceptedWorkosIssuer(
        "https://example.test/user_management/client_01KW6ZF0389TC20FTQHK4VP8KA",
        "https://api.workos.com",
      ),
    ).toBe(false);
  });

  test("extracts expected client id from WorkOS JWKS URL", () => {
    expect(
      expectedWorkosClientId(
        "https://api.workos.com/sso/jwks/client_01KWGQ818571ARFATQ3G9AR2Y2",
      ),
    ).toBe("client_01KWGQ818571ARFATQ3G9AR2Y2");
  });
});
