import { describe, expect, test } from "vitest";

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

  test("passes through human machine names from the server", () => {
    // macOS computer name (scutil --get ComputerName)
    expect(visibleConnectionLabel("Whizzy's MacBook Pro")).toBe(
      "Whizzy's MacBook Pro",
    );
    // hostname fallback with .local already stripped server-side
    expect(visibleConnectionLabel("whizzy-mbp")).toBe("whizzy-mbp");
    // username fallback
    expect(visibleConnectionLabel("whizzy")).toBe("whizzy");
  });

  test("still hides raw ids even when a real label is unknown", () => {
    expect(visibleConnectionLabel("env-abcdef012345", "env-abcdef012345")).toBe(
      "Computer",
    );
    expect(
      visibleConnectionLabel(undefined, "0123456789abcdef0123456789ab"),
    ).toBe("Computer");
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
