import { describe, expect, test } from "bun:test";

import { acceptedWorkosIssuers } from "../src/workos.ts";

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
});
