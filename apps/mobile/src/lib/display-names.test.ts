import { describe, expect, test } from "bun:test";

import {
  projectAvatarUrl,
  visibleConnectionLabel,
  visibleProjectPath,
} from "./display-names";

describe("mobile display names", () => {
  test("hides raw environment ids from visible labels", () => {
    expect(visibleConnectionLabel("env_internal_id")).toBe("Computer");
    expect(visibleConnectionLabel("Studio Mac")).toBe("Studio Mac");
  });

  test("shortens long local paths", () => {
    expect(visibleProjectPath("/Users/example/Developer/work/app")).toBe(
      "Developer/work/app",
    );
  });

  test("derives GitHub avatar URLs when an owner is inferable", () => {
    expect(projectAvatarUrl("https://github.com/acme/app.git", "app")).toBe(
      "https://github.com/acme.png?size=80",
    );
    expect(projectAvatarUrl("/Users/me/Developer/startups/delulu", "swarajbachu/delulu")).toBe(
      "https://github.com/swarajbachu.png?size=80",
    );
    expect(projectAvatarUrl("/Users/me/Developer/startups/delulu", "delulu")).toBeNull();
  });
});
