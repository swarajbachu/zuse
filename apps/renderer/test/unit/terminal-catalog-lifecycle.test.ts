import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("terminal catalog React lifecycle", () => {
	it("uses scalar-qualified chat identity for renderer hydration effects", () => {
		const bottomDock = source("../../src/components/bottom-terminal-dock.tsx");
		const terminalPane = source("../../src/components/terminal-pane.tsx");
		const rightPane = source("../../src/components/right-pane.tsx");

		expect(bottomDock).toMatch(/\[chatRef\.environmentId, chatRef\.chatId\]/);
		expect(bottomDock).toContain("bottom-terminal-catalog-request");
		expect(bottomDock).toContain(
			"activeCatalogRequestAuthorityRef.current.isCurrent(expectedRequestKey)",
		);
		expect(bottomDock).toContain(
			"activeCatalogRequestAuthorityRef.current.commit(catalogRequestKey)",
		);
		expect(bottomDock).not.toContain(
			"activeCatalogRequestKeyRef.current = catalogRequestKey",
		);
		expect(bottomDock).toContain("invalidateTerminalCatalog(");
		expect(terminalPane).toMatch(/\[chatRef\.environmentId, chatRef\.chatId\]/);
		expect(rightPane).toContain("terminalCatalogChatId,");
		expect(rightPane).toContain("terminalCatalogEnvironmentId,");
		expect(rightPane).toContain("directoryUnavailable,");
		expect(rightPane).toContain("invalidateTerminalCatalog(");
		expect(rightPane).toContain(
			"activeChatKeyAuthorityRef.current.commit(chatKey)",
		);
		expect(rightPane).toContain(
			"canonicalRootPathAuthorityRef.current.commit(executionRootPath)",
		);
		expect(rightPane).not.toContain("activeChatKeyRef.current = chatKey");
		expect(rightPane).not.toContain(
			"canonicalRootPathRef.current = executionRootPath",
		);
		expect(rightPane).not.toMatch(
			/\[\s*chatRef\s*,[^\]]*hydrateRightTerminalCatalog/,
		);
	});

	it("does not hydrate the cloud owner while its workspace is unavailable", () => {
		const rightPane = source("../../src/components/right-pane.tsx");

		expect(rightPane).toContain('activeContextStatus !== "cloud-unavailable"');
	});

	it("keeps failed catalog and detached-cloud actions visible and retryable", () => {
		const bottomDock = source("../../src/components/bottom-terminal-dock.tsx");
		const rightPane = source("../../src/components/right-pane.tsx");

		expect(bottomDock).toContain('role="alert"');
		expect(bottomDock).toContain("Retry bottom terminal catalog");
		expect(bottomDock).toContain('catalogState !== "ready"');
		expect(rightPane).toContain('role="alert"');
		expect(rightPane).toContain("wakeAndRestoreCloudRightTerminal");
		expect(rightPane).toContain("waitForCanonicalRootPath");
		expect(rightPane).toContain("Retry");
	});

	it("routes the ordinary project Terminal menu through the catalog gate", () => {
		const rightPane = source("../../src/components/right-pane.tsx");

		expect(rightPane).toContain('if (kind === "terminal")');
		expect(rightPane).toContain("handleAddProjectTerminal();");
		expect(rightPane).toContain("projectTerminalDisabledReason");
	});

	it("does not reuse catalog-ready state across environment or reconnect identity", () => {
		const terminalPane = source("../../src/components/terminal-pane.tsx");

		expect(terminalPane).toContain("catalogRequestKey");
		expect(terminalPane).toContain("cloudShell.connection,");
		expect(terminalPane).toContain(
			"catalogStatus.requestKey === catalogRequestKey",
		);
		expect(terminalPane).toContain('Symbol("terminal-catalog-attempt")');
		expect(terminalPane).toContain("current.attempt === attempt");
		expect(terminalPane).toContain("terminalOwnerLimitReached(");
	});

	it("routes command terminals through the same authoritative controller", () => {
		const bottomDock = source("../../src/components/bottom-terminal-dock.tsx");
		const runTerminal = source("../../src/lib/run-terminal.ts");

		expect(bottomDock).toContain("runCatalogAction(true)");
		expect(bottomDock).not.toContain("openNewBottomTerminal");
		expect(runTerminal).toContain("restoreOrAddRightTerminal({");
		expect(runTerminal).toContain("reuseRestored: false");
		expect(runTerminal).not.toContain("useTerminalsStore");
	});
});
