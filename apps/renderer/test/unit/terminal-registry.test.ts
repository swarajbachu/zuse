import {
	EnvironmentId,
	PtyId,
	PtyOpenRpc,
	PtyOpenToken,
	PtyOwnerId,
	PtyOwnership,
} from "@zuse/contracts";
import { Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalClient = vi.hoisted(() => ({
	dispatchTerminalClose: vi.fn(async () => undefined),
	dispatchTerminalOpen: vi.fn(),
	dispatchTerminalResize: vi.fn(async () => undefined),
	dispatchTerminalRestart: vi.fn(),
	retainTerminalResource: vi.fn(),
}));

const ghostty = vi.hoisted(() => ({
	ready: vi.fn<() => Promise<void>>(),
}));
const clientBus = vi.hoisted(() => ({
	listener: null as ((view: unknown) => void) | null,
}));

vi.mock("../../src/lib/terminal-client-bus.ts", () => ({
	dispatchTerminalClose: terminalClient.dispatchTerminalClose,
	dispatchTerminalInput: vi.fn(),
	dispatchTerminalOpen: terminalClient.dispatchTerminalOpen,
	dispatchTerminalRename: vi.fn(),
	dispatchTerminalResize: terminalClient.dispatchTerminalResize,
	dispatchTerminalRestart: terminalClient.dispatchTerminalRestart,
	retainTerminalResource: terminalClient.retainTerminalResource,
}));

vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	getRendererClientBus: () => ({
		snapshot: () => ({ data: null, connection: "dormant" }),
		subscribe: (_key: unknown, listener: (view: unknown) => void) => {
			clientBus.listener = listener;
			return () => {
				clientBus.listener = null;
			};
		},
	}),
}));

vi.mock("../../src/lib/diagnostics-recorder.ts", () => ({
	recordDiagnosticEvent: vi.fn(),
}));

vi.mock("../../src/terminal/ghostty/surface.ts", () => ({
	GhosttySurface: class {
		readonly cols = 80;
		readonly rows = 24;
		open() {}
		onData() {
			return { dispose: () => undefined };
		}
		onResize() {
			return { dispose: () => undefined };
		}
		fit() {}
		refreshTheme() {}
		ready() {
			return ghostty.ready();
		}
		reset() {
			return Promise.resolve();
		}
		write() {
			return Promise.resolve();
		}
		dispose() {}
	},
}));

import {
	attach,
	dispose,
	getStatusesSnapshot,
	getTerminalFailureMessage,
	reconcilePtyBinding,
	restart,
	terminalOpenOwnership,
	terminalRuntimeKey,
} from "../../src/lib/terminal-registry.ts";

type FakeElement = {
	parentElement: FakeElement | null;
	className: string;
	dataset: Record<string, string>;
	clientWidth: number;
	clientHeight: number;
	appendChild: (child: FakeElement) => void;
	remove: () => void;
};

const makeElement = (): FakeElement => {
	const element: FakeElement = {
		parentElement: null,
		className: "",
		dataset: {},
		clientWidth: 800,
		clientHeight: 400,
		appendChild: (child) => {
			child.parentElement = element;
		},
		remove: () => {
			element.parentElement = null;
		},
	};
	return element;
};

const ownerId = PtyOwnerId.make("desktop-owner");
const bottomOwnerId = PtyOwnerId.make("desktop-terminal:chat:bottom");

describe("terminal registry ownership", () => {
	it("uses collision-free environment and logical terminal tuple keys", () => {
		expect(terminalRuntimeKey("environment:terminal", "slot")).not.toBe(
			terminalRuntimeKey("environment", "terminal:slot"),
		);
	});

	beforeEach(() => {
		terminalClient.dispatchTerminalClose.mockClear();
		terminalClient.dispatchTerminalOpen.mockReset();
		terminalClient.dispatchTerminalResize.mockClear();
		terminalClient.dispatchTerminalRestart.mockReset();
		terminalClient.retainTerminalResource.mockReset();
		terminalClient.retainTerminalResource.mockImplementation((ref) => ({
			key: { kind: "terminal", ref },
			lease: { activate: () => undefined, release: () => undefined },
		}));
		ghostty.ready.mockReset();
		ghostty.ready.mockResolvedValue(undefined);
		clientBus.listener = null;
		vi.stubGlobal("document", { createElement: () => makeElement() });
		vi.stubGlobal("window", {
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			requestAnimationFrame: (callback: () => void) => {
				callback();
				return 1;
			},
			cancelAnimationFrame: () => undefined,
		});
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
	});

	it("closes a catalog-restored PTY before its surface is mounted", async () => {
		const environmentId = EnvironmentId.make("terminal-environment");
		const serverPtyId = PtyId.make("server-pty");

		await dispose(environmentId, PtyId.make("logical-slot"), {
			serverPtyId,
			ownerId: bottomOwnerId,
		});

		expect(terminalClient.dispatchTerminalClose).toHaveBeenCalledOnce();
		expect(terminalClient.dispatchTerminalClose).toHaveBeenCalledWith(
			{ environmentId, terminalId: serverPtyId },
			"desktop-terminal:chat:bottom",
		);
	});

	it("does not guess a server process for an unbound renderer slot", async () => {
		await dispose(
			EnvironmentId.make("terminal-environment"),
			PtyId.make("pending-slot"),
		);

		expect(terminalClient.dispatchTerminalClose).not.toHaveBeenCalled();
	});

	it("uses the logical renderer instance as the stable server open token", () => {
		const instanceId = PtyId.make("logical-terminal-instance");
		const ownership = terminalOpenOwnership(
			instanceId,
			ownerId,
			"Project shell",
		);
		expect(ownership).toEqual({
			ownerId: "desktop-owner",
			label: "Project shell",
			scope: "session",
			openToken: PtyOpenToken.make(instanceId),
		});
		expect(ownership).toBeInstanceOf(PtyOwnership);
		expect(() =>
			Schema.encodeSync(PtyOpenRpc.payloadSchema)({
				cwd: "/workspace",
				cols: 80,
				rows: 24,
				ownership,
			}),
		).not.toThrow();
	});

	it("does not duplicate an open while one logical slot is pending", async () => {
		terminalClient.dispatchTerminalOpen.mockImplementation(
			() => new Promise(() => undefined),
		);
		const environmentId = EnvironmentId.make("terminal-environment");
		const instanceId = PtyId.make("pending-logical-terminal");
		const container = makeElement() as unknown as HTMLElement;
		const options = {
			cwd: "/workspace",
			ownerId,
			title: "Project shell",
		};

		attach(environmentId, instanceId, container, options);
		attach(environmentId, instanceId, container, options);
		await vi.waitFor(() =>
			expect(terminalClient.dispatchTerminalOpen).toHaveBeenCalledOnce(),
		);
		expect(terminalClient.dispatchTerminalOpen).toHaveBeenCalledWith(
			environmentId,
			expect.objectContaining({
				ownership: expect.objectContaining({
					openToken: PtyOpenToken.make(instanceId),
				}),
			}),
		);

		await dispose(environmentId, instanceId);
	});

	it("does not open or retain a PTY before the Ghostty renderer is ready", async () => {
		let resolveReady: (() => void) | undefined;
		ghostty.ready.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveReady = resolve;
			}),
		);
		terminalClient.dispatchTerminalOpen.mockResolvedValue({
			ptyId: PtyId.make("ready-server-pty"),
			processEpoch: "ready-epoch",
		});
		const environmentId = EnvironmentId.make("terminal-environment");
		const instanceId = PtyId.make("renderer-readiness-terminal");
		attach(environmentId, instanceId, makeElement() as unknown as HTMLElement, {
			cwd: "/workspace",
			ownerId,
			title: "Project shell",
		});

		await Promise.resolve();
		expect(terminalClient.dispatchTerminalOpen).not.toHaveBeenCalled();
		expect(terminalClient.retainTerminalResource).not.toHaveBeenCalled();

		resolveReady?.();
		await vi.waitFor(() =>
			expect(terminalClient.dispatchTerminalOpen).toHaveBeenCalledOnce(),
		);
		await vi.waitFor(() =>
			expect(terminalClient.retainTerminalResource).toHaveBeenCalledOnce(),
		);

		await dispose(environmentId, instanceId);
	});

	it("does not retain a restored PTY when Ghostty initialization fails", async () => {
		ghostty.ready.mockRejectedValue(new Error("WASM initialization failed"));
		const environmentId = EnvironmentId.make("terminal-environment");
		const instanceId = PtyId.make("failed-renderer-terminal");
		attach(environmentId, instanceId, makeElement() as unknown as HTMLElement, {
			cwd: "/workspace",
			ownerId,
			title: "Project shell",
			serverPtyId: PtyId.make("restored-server-pty"),
		});

		await vi.waitFor(() =>
			expect(
				getStatusesSnapshot()[terminalRuntimeKey(environmentId, instanceId)],
			).toBe("failed"),
		);
		expect(terminalClient.dispatchTerminalOpen).not.toHaveBeenCalled();
		expect(terminalClient.retainTerminalResource).not.toHaveBeenCalled();
		expect(getTerminalFailureMessage(environmentId, instanceId)).toBe(
			"Terminal renderer failed to initialize. Close it, then reopen.",
		);

		await dispose(environmentId, instanceId);
	});

	it("exposes resource failures as actionable terminal status", async () => {
		const environmentId = EnvironmentId.make("failure-environment");
		const instanceId = PtyId.make("failure-terminal");
		attach(environmentId, instanceId, makeElement() as unknown as HTMLElement, {
			cwd: "/workspace",
			ownerId,
			title: "Shell",
			serverPtyId: PtyId.make("failure-server-pty"),
		});
		await vi.waitFor(() => expect(clientBus.listener).not.toBeNull());
		clientBus.listener?.({
			connection: "connected",
			data: {
				phase: "failed",
				processEpoch: "epoch",
				failure: {
					kind: "replay-gap",
					message: "Terminal output is no longer available from this cursor.",
					gap: null,
				},
			},
		});
		expect(getTerminalFailureMessage(environmentId, instanceId)).toBe(
			"Terminal output is no longer available from this cursor. Restart the terminal to continue.",
		);
		await dispose(environmentId, instanceId);
	});

	it("adopts a catalog-reconciled process after an open acknowledgement is lost", async () => {
		terminalClient.dispatchTerminalOpen.mockRejectedValue(
			new Error("response lost"),
		);
		const environmentId = EnvironmentId.make("terminal-environment");
		const instanceId = PtyId.make("reconciled-logical-terminal");
		const serverPtyId = PtyId.make("reconciled-server-pty");
		attach(environmentId, instanceId, makeElement() as unknown as HTMLElement, {
			cwd: "/workspace",
			ownerId,
			title: "Project shell",
		});
		await vi.waitFor(() =>
			expect(
				getStatusesSnapshot()[terminalRuntimeKey(environmentId, instanceId)],
			).toBe("failed"),
		);

		expect(reconcilePtyBinding(environmentId, instanceId, serverPtyId)).toBe(
			true,
		);
		expect(terminalClient.retainTerminalResource).toHaveBeenCalledOnce();
		expect(
			getStatusesSnapshot()[terminalRuntimeKey(environmentId, instanceId)],
		).toBe("connecting");

		await dispose(environmentId, instanceId);
		expect(terminalClient.dispatchTerminalClose).toHaveBeenCalledWith(
			{ environmentId, terminalId: serverPtyId },
			"desktop-owner",
		);
	});

	it("publishes a retained process exit to its owner state", async () => {
		const environmentId = EnvironmentId.make("terminal-exit-environment");
		const instanceId = PtyId.make("terminal-exit-instance");
		const onStatusChanged = vi.fn();
		attach(environmentId, instanceId, makeElement() as unknown as HTMLElement, {
			cwd: "/workspace",
			ownerId,
			title: "Project shell",
			serverPtyId: PtyId.make("terminal-exit-server"),
			processEpoch: "terminal-exit-epoch",
			onStatusChanged,
		});
		await vi.waitFor(() => expect(clientBus.listener).not.toBeNull());

		clientBus.listener?.({
			data: {
				phase: "exited",
				processEpoch: "terminal-exit-epoch",
				failure: null,
			},
			connection: "connected",
		});

		expect(onStatusChanged).toHaveBeenCalledWith("exited");
		await dispose(environmentId, instanceId);
	});

	it("explains the owner limit and retries the same logical open from Restart", async () => {
		terminalClient.dispatchTerminalOpen.mockRejectedValueOnce({
			_tag: "PtyOwnerLimitError",
			ownerId: "desktop-owner",
			limit: 4,
		});
		const environmentId = EnvironmentId.make("terminal-environment");
		const instanceId = PtyId.make("retryable-logical-terminal");
		const serverPtyId = PtyId.make("retried-server-pty");
		attach(environmentId, instanceId, makeElement() as unknown as HTMLElement, {
			cwd: "/workspace",
			ownerId,
			title: "Project shell",
		});
		await vi.waitFor(() =>
			expect(getTerminalFailureMessage(environmentId, instanceId)).toBe(
				"Terminal limit reached (4). Close a terminal, then retry.",
			),
		);

		terminalClient.dispatchTerminalOpen.mockResolvedValueOnce({
			ptyId: serverPtyId,
			processEpoch: "epoch-retried",
		});
		await restart(environmentId, instanceId);
		expect(terminalClient.dispatchTerminalOpen).toHaveBeenCalledTimes(2);
		const openTokens = terminalClient.dispatchTerminalOpen.mock.calls.map(
			([, payload]) => payload.ownership?.openToken,
		);
		expect(openTokens).toEqual([
			PtyOpenToken.make(instanceId),
			PtyOpenToken.make(instanceId),
		]);
		expect(getTerminalFailureMessage(environmentId, instanceId)).toBeNull();

		await dispose(environmentId, instanceId);
	});

	it("restarts with the known epoch and advances the next CAS precondition", async () => {
		const environmentId = EnvironmentId.make("terminal-environment");
		const instanceId = PtyId.make("restart-cas-logical-terminal");
		const serverPtyId = PtyId.make("restart-cas-server-pty");
		const onPtyBound = vi.fn();
		terminalClient.dispatchTerminalRestart
			.mockResolvedValueOnce({
				ptyId: serverPtyId,
				processEpoch: "epoch-after-first-restart",
			})
			.mockResolvedValueOnce({
				ptyId: serverPtyId,
				processEpoch: "epoch-after-second-restart",
			});
		attach(environmentId, instanceId, makeElement() as unknown as HTMLElement, {
			cwd: "/workspace",
			ownerId,
			title: "Project shell",
			serverPtyId,
			processEpoch: "epoch-before-restart",
			onPtyBound,
		});
		await vi.waitFor(() =>
			expect(terminalClient.retainTerminalResource).toHaveBeenCalledOnce(),
		);

		await restart(environmentId, instanceId);
		expect(terminalClient.dispatchTerminalRestart).toHaveBeenNthCalledWith(
			1,
			{ environmentId, terminalId: serverPtyId },
			"desktop-owner",
			"epoch-before-restart",
		);
		expect(onPtyBound).toHaveBeenNthCalledWith(
			1,
			serverPtyId,
			"epoch-after-first-restart",
		);

		await restart(environmentId, instanceId);
		expect(terminalClient.dispatchTerminalRestart).toHaveBeenNthCalledWith(
			2,
			{ environmentId, terminalId: serverPtyId },
			"desktop-owner",
			"epoch-after-first-restart",
		);

		await dispose(environmentId, instanceId);
	});

	it("keeps an owner-limit restart failure actionable", async () => {
		terminalClient.dispatchTerminalRestart.mockRejectedValue({
			_tag: "PtyOwnerLimitError",
			ownerId: "desktop-owner",
			limit: 4,
		});
		const environmentId = EnvironmentId.make("terminal-environment");
		const instanceId = PtyId.make("exited-logical-terminal");
		attach(environmentId, instanceId, makeElement() as unknown as HTMLElement, {
			cwd: "/workspace",
			ownerId,
			title: "Project shell",
			serverPtyId: PtyId.make("exited-server-pty"),
		});
		await vi.waitFor(() =>
			expect(terminalClient.retainTerminalResource).toHaveBeenCalledOnce(),
		);

		await expect(restart(environmentId, instanceId)).rejects.toMatchObject({
			_tag: "PtyOwnerLimitError",
		});
		expect(getTerminalFailureMessage(environmentId, instanceId)).toBe(
			"Terminal limit reached (4). Close a terminal, then retry.",
		);

		await dispose(environmentId, instanceId);
	});
});
