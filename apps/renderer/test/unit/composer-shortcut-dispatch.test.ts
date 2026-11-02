import { parseKey } from "@zuse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeybindingDispatch } from "../../src/hooks/use-keybinding-dispatch.ts";

const { dispatch, listeners } = vi.hoisted(() => ({
	dispatch: vi.fn(),
	listeners: [] as Array<(event: KeyboardEvent) => void>,
}));
vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));
vi.mock("../../src/lib/host-platform", () => ({ isMacHost: () => false }));
vi.mock("../../src/lib/commands", () => ({
	APPLICATION_COMMANDS: new Set(["close-tab"]),
	dispatchCommand: dispatch,
}));
vi.mock("../../src/lib/keybindings-client-bus.ts", () => ({
	useKeybindings: () => undefined,
	keybindingsSnapshot: () => ({
		resolvedRules: [
			{
				rule: { command: "close-tab", key: "mod+w" },
				shortcut: parseKey("mod+w"),
				whenAst: null,
			},
		],
	}),
}));
afterEach(() => {
	listeners.length = 0;
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("composer shortcut precedence", () => {
	it("keeps a consumed editing shortcut from also closing the tab", () => {
		vi.stubGlobal("document", {
			addEventListener: (
				_name: string,
				listener: (event: KeyboardEvent) => void,
			) => listeners.push(listener),
		});
		useKeybindingDispatch();
		const event = {
			key: "w",
			ctrlKey: true,
			metaKey: false,
			altKey: false,
			shiftKey: false,
			defaultPrevented: true,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as KeyboardEvent;
		listeners[0]?.(event);
		expect(dispatch).not.toHaveBeenCalled();
		listeners[0]?.({ ...event, defaultPrevented: false } as KeyboardEvent);
		expect(dispatch).toHaveBeenCalledWith("close-tab");
	});
});
