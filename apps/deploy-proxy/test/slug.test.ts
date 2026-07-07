import { describe, expect, test } from "bun:test";

import {
  projectNameFor,
  slugify,
  subdomainCandidates,
  userHash8,
} from "../src/slug.ts";

describe("slugify", () => {
  test("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
  });

  test("collapses runs and trims edge dashes", () => {
    expect(slugify("--a__b--")).toBe("a-b");
  });

  test("falls back for empty input", () => {
    expect(slugify("!!!")).toBe("app");
  });

  test("caps length", () => {
    expect(slugify("x".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("userHash8", () => {
  test("is stable and 8 hex chars", () => {
    expect(userHash8("user_123")).toBe(userHash8("user_123"));
    expect(userHash8("user_123")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("differs across users", () => {
    expect(userHash8("user_a")).not.toBe(userHash8("user_b"));
  });
});

describe("naming", () => {
  test("project name is user-namespaced", () => {
    const name = projectNameFor("user_123", "my-app");
    expect(name).toBe(`zuse-${userHash8("user_123")}-my-app`);
  });

  test("subdomain candidates prefer bare slug", () => {
    const [first, second] = subdomainCandidates("user_123", "my-app");
    expect(first).toBe("my-app");
    expect(second).toBe(`my-app-${userHash8("user_123").slice(0, 4)}`);
  });
});
