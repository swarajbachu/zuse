import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SelectorRow } from "../../../src/components/selector-row";

const state = vi.hoisted(() => ({
	open: false,
	press: new Map<string, () => void>(),
	close: undefined as (() => void) | undefined,
	effects: [] as Array<() => void>,
}));
vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useState: () => [
		state.open,
		(open: boolean) => {
			state.open = open;
		},
	],
	useEffect: (effect: () => void) => {
		state.effects.push(effect);
	},
}));
vi.mock("lucide-react-native", () => ({
	Check: () => null,
	ChevronsUpDown: () => null,
}));
vi.mock("~/theme", () => ({ colors: { fg: "black", tertiaryFg: "gray" } }));
vi.mock("react-native", () => ({
	Text: "span",
	View: "div",
	ScrollView: "section",
	Pressable: ({
		children,
		accessibilityLabel,
		accessibilityState,
		onPress,
		className,
	}: {
		children?: ReactNode;
		accessibilityLabel: string;
		accessibilityState?: {
			selected?: boolean;
			disabled?: boolean;
			expanded?: boolean;
		};
		onPress: () => void;
		className?: string;
	}) => {
		state.press.set(accessibilityLabel, onPress);
		return createElement(
			"button",
			{
				type: "button",
				className,
				"aria-label": accessibilityLabel,
				"aria-selected": accessibilityState?.selected,
				"aria-disabled": accessibilityState?.disabled,
				"aria-expanded": accessibilityState?.expanded,
			},
			children,
		);
	},
	Modal: ({
		visible,
		onRequestClose,
		children,
	}: {
		visible: boolean;
		onRequestClose: () => void;
		children: ReactNode;
	}) => {
		state.close = onRequestClose;
		return visible ? children : null;
	},
}));
vi.mock("~/components/ui/button", () => ({
	Button: ({
		onPress,
		children,
	}: {
		onPress: () => void;
		children: ReactNode;
	}) => {
		state.press.set("Cancel", onPress);
		return createElement("button", { type: "button" }, children);
	},
}));
const selected = vi.fn();
const options = Array.from({ length: 8 }, (_, index) => ({
	key: `org_${index}`,
	label: `Team ${index}`,
	selected: index === 3,
	onSelect: () => selected(index, state.open),
}));
const render = (props: Partial<Parameters<typeof SelectorRow>[0]> = {}) => {
	state.press.clear();
	const markup = renderToStaticMarkup(
		createElement(SelectorRow, {
			label: "Workspace",
			symbol: "person.2",
			compact: true,
			options,
			...props,
		}),
	);
	for (const effect of state.effects.splice(0)) effect();
	return markup;
};

describe("non-iOS shared selector", () => {
	beforeEach(() => {
		state.open = false;
		state.effects = [];
		state.press.clear();
		selected.mockClear();
	});
	test("opens all organizations, reflects selection, and closes before selecting", () => {
		expect(render()).not.toContain("Team 7");
		state.press.get("Workspace")?.();
		const markup = render();
		expect(markup).toContain("Team 7");
		expect(markup).toContain('aria-selected="true"');
		expect(markup).toContain('aria-expanded="true"');
		expect(markup).toContain("h-7");
		state.press.get("Team 7")?.();
		expect(selected).toHaveBeenCalledWith(7, false);
		expect(render()).not.toContain("Team 7");
	});
	test.each([
		"Cancel",
		"Dismiss selection",
		"system-back",
	])("%s dismisses without changing the selection", (action) => {
		state.open = true;
		render();
		if (action === "system-back") state.close?.();
		else state.press.get(action)?.();
		expect(state.open).toBe(false);
		expect(selected).not.toHaveBeenCalled();
	});
	test.each(["disabled", "empty"])("%s controls cannot open", (reason) => {
		render(reason === "disabled" ? { disabled: true } : { options: [] });
		state.press.get("Workspace")?.();
		expect(state.open).toBe(false);
	});
	test("becoming disabled dismisses an open menu and does not reopen it later", () => {
		state.open = true;
		expect(render({ disabled: true })).not.toContain("Team 7");
		expect(state.open).toBe(false);
		expect(render()).not.toContain("Team 7");
	});
	test("an open picker uses the latest option callbacks", () => {
		state.open = true;
		render();
		const next = vi.fn();
		render({
			options: [
				{ key: "org_0", label: "Team 0", selected: true, onSelect: next },
			],
		});
		state.press.get("Team 0")?.();
		expect(next).toHaveBeenCalledOnce();
		expect(selected).not.toHaveBeenCalled();
	});
});
