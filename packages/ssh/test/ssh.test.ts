import { describe, expect, test } from "bun:test";

import {
  parseHostAliases,
  parseLaunchResult,
  parseSshGConfig,
  remoteLaunchScript,
  sshGArgs,
  tunnelArgs,
} from "../src/index.ts";

describe("@zuse/ssh", () => {
  test("parses ssh -G output", () => {
    expect(
      parseSshGConfig(
        "devbox",
        "user alice\nhostname example.test\nport 2222\nidentityfile ~/.ssh/id_ed25519\n",
      ),
    ).toEqual({
      host: "devbox",
      hostname: "example.test",
      user: "alice",
      port: 2222,
      identityFile: "~/.ssh/id_ed25519",
    });
  });

  test("discovers concrete Host aliases only", () => {
    expect(
      parseHostAliases("Host dev prod-*\n  User alice\nHost !bad staging\n"),
    ).toEqual(["dev", "staging"]);
  });

  test("builds native ssh commands", () => {
    expect(sshGArgs("devbox")).toEqual(["-G", "devbox"]);
    expect(tunnelArgs({ host: "devbox", localPort: 3001, remotePort: 8787 }))
      .toContain("127.0.0.1:3001:127.0.0.1:8787");
  });

  test("emits and parses launch response contract", () => {
    expect(remoteLaunchScript()).toContain("serverKind");
    expect(parseLaunchResult('{"remotePort":8787,"serverKind":"zuse"}'))
      .toEqual({ remotePort: 8787, serverKind: "zuse" });
  });
});
