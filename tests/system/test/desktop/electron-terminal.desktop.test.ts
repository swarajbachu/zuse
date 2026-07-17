import { join } from "node:path";
import { installFakeAcpProvider, waitForFile } from "@zuse/testkit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  createSystemConversation,
  initializeSystemRepository,
} from "../../src/conversation-fixture.ts";
import { launchElectronApp } from "../../src/electron-app.ts";
import { withSystemTest } from "../../src/system-scope.ts";

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

describe("built Electron terminal", () => {
  it("preserves input order, survives output load, and exposes unrecoverable gaps", async () => {
    await withSystemTest("zuse-electron-terminal-", async (scope) => {
      const repository = scope.path("repository");
      initializeSystemRepository(repository);
      const server = await scope.server();
      const rpc = await scope.rpc(server.endpoint);
      const provider = installFakeAcpProvider({ root: scope.root });
      await Effect.runPromise(
        rpc.client["settings.update"]({
          patch: {
            onboardingCompleted: true,
            defaultProviderId: "gemini",
            defaultAutoCreateWorktree: false,
          },
        }),
      );
      const { folder, conversation } = await createSystemConversation(
        rpc.client,
        repository,
      );
      await Effect.runPromise(
        rpc.client["workspace.setSelected"]({ folderId: folder.id }),
      );
      await rpc.dispose();
      await server.stop();

      const electron = await scope.acquire(
        () =>
          launchElectronApp({
            root: scope.root,
            userData: server.userData,
            providerBinDirectory: provider.binDirectory,
          }),
        (value) => value.close(),
      );
      const page = electron.page;
      await page
        .getByText(conversation.chat.title, { exact: true })
        .first()
        .click();
      await page.keyboard.press("Meta+j");

      let terminal = page.locator("[data-terminal-instance-id]").last();
      await terminal.waitFor({ state: "visible", timeout: 20_000 });
      await expect
        .poll(() => terminal.getAttribute("data-terminal-status"), {
          timeout: 20_000,
        })
        .toBe("running");
      const input = terminal.locator(".xterm-helper-textarea");
      await input.focus();

      const orderedMarker = join(scope.root, "ordered-input-ok");
      const token = "terminalreliability0123456789backspacecheck";
      await page.keyboard.type(token);
      for (let index = 0; index < token.length; index += 1) {
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.type(`/usr/bin/touch ${shellQuote(orderedMarker)}`);
      await page.keyboard.press("Enter");
      await waitForFile(orderedMarker, 10_000);

      const floodMarker = join(scope.root, "flood-finished");
      await page.keyboard.type(
        `i=0; while [ $i -lt 20000 ]; do printf 'terminal-line-%s\\n' "$i"; i=$((i+1)); done; /usr/bin/touch ${shellQuote(floodMarker)}`,
      );
      await page.keyboard.press("Enter");
      await waitForFile(floodMarker, 20_000);
      await expect
        .poll(() => terminal.getAttribute("data-terminal-status"), {
          timeout: 10_000,
        })
        .toBe("running");

      const gapStarted = join(scope.root, "gap-started");
      await page.keyboard.type(
        `/usr/bin/touch ${shellQuote(gapStarted)}; sleep 0.3; i=0; while [ $i -lt 200000 ]; do printf '012345678901234567890123456789%s\\n' "$i"; i=$((i+1)); done`,
      );
      await page.keyboard.press("Enter");
      await waitForFile(gapStarted, 10_000);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect
        .poll(() => terminal.getAttribute("data-terminal-status"), {
          timeout: 5_000,
        })
        .toBe("reconnecting");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect
        .poll(() => terminal.getAttribute("data-terminal-status"), {
          timeout: 20_000,
        })
        .toBe("failed");
      await page
        .getByRole("status", {
          name: "Terminal disconnected — close it and open a new terminal",
        })
        .waitFor({ state: "visible" });

      await page
        .getByRole("button", { name: /^Close zsh/ })
        .last()
        .click();
      await page.keyboard.press("Meta+j");
      terminal = page.locator("[data-terminal-instance-id]").last();
      await expect
        .poll(() => terminal.getAttribute("data-terminal-status"), {
          timeout: 20_000,
        })
        .toBe("running");
      const replacementMarker = join(scope.root, "replacement-ok");
      await terminal.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(
        `/usr/bin/touch ${shellQuote(replacementMarker)}`,
      );
      await page.keyboard.press("Enter");
      await waitForFile(replacementMarker, 10_000);
      expect(electron.errors).toEqual([]);
    });
  }, 90_000);
});
