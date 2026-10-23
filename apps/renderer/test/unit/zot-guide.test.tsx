import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZotGuideBody } from "../../src/components/masters/zot-guide.tsx";
import { Popover } from "../../src/components/ui/popover.tsx";
import {
	findZotGuideTarget,
	insertZotExample,
	leaseDetailsPanel,
	restoreZotGuideFocus,
	ZOT_GUIDE_TARGETS,
	zotGuideVisible,
} from "../../src/lib/zot-guide.ts";
import { useMastersStore } from "../../src/store/masters.ts";
import {
	ZOT_ONBOARDING_STEPS,
	type ZotOnboardingStep,
} from "../../src/store/zot-onboarding.ts";

/** Lets subscriptions settle whether the store notifies now or later. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const fakeElement = ({
	inert = false,
	visible = true,
}: {
	inert?: boolean;
	visible?: boolean;
}) => ({
	closest: (selector: string) =>
		selector === "[inert]" && inert ? ({} as Element) : null,
	getClientRects: () => ({ length: visible ? 1 : 0 }) as unknown as DOMRectList,
});

const fakeRoot = (elements: Record<string, ReturnType<typeof fakeElement>>) => {
	const queries: string[] = [];
	return {
		queries,
		querySelector: (selector: string) => {
			queries.push(selector);
			const match = /^\[data-zot-guide="([a-z]+)"\]$/.exec(selector);
			return (match?.[1] && elements[match[1]]) || null;
		},
	};
};

describe("Zot guide targets", () => {
	it("looks up only the scoped data marker for the step", () => {
		const slaves = fakeElement({});
		const root = fakeRoot({ slaves });
		expect(findZotGuideTarget(root, ZOT_GUIDE_TARGETS.slaves)).toBe(slaves);
		expect(root.queries).toEqual(['[data-zot-guide="slaves"]']);
	});

	it("falls back when the target is missing, hidden, or in an inert panel", () => {
		const root = fakeRoot({
			repositories: fakeElement({ inert: true }),
			slaves: fakeElement({ visible: false }),
		});
		expect(findZotGuideTarget(root, "repositories")).toBeNull();
		expect(findZotGuideTarget(root, "slaves")).toBeNull();
		expect(findZotGuideTarget(root, "brief")).toBeNull();
		expect(findZotGuideTarget(null, "brief")).toBeNull();
		expect(findZotGuideTarget(root, null)).toBeNull();
		expect(ZOT_GUIDE_TARGETS.welcome).toBe("identity");
	});
});

describe("Details panel lease on the real masters store", () => {
	afterEach(() => useMastersStore.setState({ railOpen: null }));

	it("opens a closed panel and closes it again when the guide moves on", async () => {
		useMastersStore.getState().setRailOpen(false);
		const lease = leaseDetailsPanel(useMastersStore);
		lease.acquire();
		await settle();
		expect(useMastersStore.getState().railOpen).toBe(true);
		lease.release();
		await settle();
		expect(useMastersStore.getState().railOpen).toBe(false);
	});

	it("leaves an already open panel alone", async () => {
		const lease = leaseDetailsPanel(useMastersStore);
		lease.acquire();
		lease.release();
		await settle();
		expect(useMastersStore.getState().railOpen).toBeNull();
	});

	it("keeps the user's choice when they toggle Details during the guide", async () => {
		useMastersStore.getState().setRailOpen(false);
		const lease = leaseDetailsPanel(useMastersStore);
		lease.acquire();
		await settle();
		useMastersStore.getState().setRailOpen(false);
		await settle();
		useMastersStore.getState().setRailOpen(true);
		await settle();
		lease.release();
		await settle();
		expect(useMastersStore.getState().railOpen).toBe(true);

		const hidden = leaseDetailsPanel(useMastersStore);
		useMastersStore.getState().setRailOpen(false);
		hidden.acquire();
		await settle();
		useMastersStore.getState().setRailOpen(false);
		await settle();
		hidden.release();
		await settle();
		expect(useMastersStore.getState().railOpen).toBe(false);
	});
});

describe("Try an example", () => {
	const KEY = "env:session";
	const bridge = (draftKey: string | null) => ({
		draftKey,
		insertText: vi.fn<(text: string) => void>(),
		sendText: vi.fn(),
	});

	it("only inserts editable text into this Zot's composer and never sends", () => {
		const own = bridge(KEY);
		expect(insertZotExample(own, KEY, "Review this repository")).toBe(true);
		expect(own.insertText).toHaveBeenCalledExactlyOnceWith(
			"Review this repository",
		);
		expect(own.sendText).not.toHaveBeenCalled();

		const other = bridge("env:other-session");
		expect(insertZotExample(other, KEY, "x")).toBe(false);
		expect(insertZotExample(own, null, "x")).toBe(false);
		expect(other.insertText).not.toHaveBeenCalled();
		expect(
			insertZotExample({ draftKey: KEY, insertText: null }, KEY, "x"),
		).toBe(false);
	});
});

describe("Zot guide card", () => {
	const render = (
		step: ZotOnboardingStep,
		options: {
			hasRepositories?: boolean;
			onTryExample?: (() => void) | null;
			targetHidden?: boolean;
		} = {},
	) => {
		const callbacks = {
			onSkip: vi.fn(),
			onBack: vi.fn(),
			onNext: vi.fn(),
			onGoTo: vi.fn(),
		};
		const markup = renderToStaticMarkup(
			<Popover open>
				<ZotGuideBody
					step={step}
					hasRepositories={options.hasRepositories ?? true}
					onTryExample={options.onTryExample ?? null}
					targetHidden={options.targetHidden ?? false}
					{...callbacks}
				/>
			</Popover>,
		);
		return { markup, callbacks };
	};

	it("opens with the plan, then walks four steps with Back and Done", () => {
		const welcome = render("welcome").markup;
		expect(welcome).toContain("Show me around");
		expect(welcome).toContain("Not now");
		expect(welcome.includes(">Back<")).toBe(false);
		for (const title of [
			"Choose repositories",
			"Write a brief",
			"Follow its slaves",
			"Start fresh, keep context",
		])
			expect(welcome).toContain(title);
		for (const [index, step] of ZOT_ONBOARDING_STEPS.slice(1).entries()) {
			const { markup } = render(step);
			expect(markup).toContain(`${index + 1} of 4`);
			expect(markup).toContain('aria-label="Skip guide"');
			expect(markup).toContain(">Back<");
			expect(markup).toContain(index === 3 ? "Done" : "Next");
		}
	});

	it("is inert: rendering never calls back or runs anything", () => {
		const { callbacks } = render("brief", { onTryExample: vi.fn() });
		for (const callback of Object.values(callbacks))
			expect(callback).not.toHaveBeenCalled();
	});

	it("offers the example only when it can reach this Zot's composer", () => {
		expect(render("brief").markup).not.toContain("Try an example");
		const { markup } = render("brief", { onTryExample: vi.fn() });
		expect(markup).toContain("Try an example");
		expect(markup).toContain("Nothing is sent.");
	});

	it("explains how to get a repository when none is added", () => {
		expect(render("repositories", { hasRepositories: false }).markup).toContain(
			"Open a repository in Zuse first",
		);
	});

	it("explains a hidden target instead of pointing at nothing", () => {
		expect(render("slaves", { targetHidden: true }).markup).toContain(
			"isn’t visible right now",
		);
		expect(render("slaves").markup).not.toContain("isn’t visible right now");
	});

	it("does not promise cross-environment work or running generated screens", () => {
		const copy = ZOT_ONBOARDING_STEPS.map((step) => render(step).markup).join(
			"\n",
		);
		expect(copy).toContain("run on the computer it was created on");
		expect(copy).not.toMatch(/other computers|move .* home|generated screen/i);
	});
});

describe("Zot guide focus", () => {
	const KEY = "env:coordinator";

	it("holds an automatic guide until this Zot's composer has mounted", () => {
		const auto = { open: true, waitForComposer: true, draftKey: KEY };
		expect(zotGuideVisible({ ...auto, bridgeDraftKey: null })).toBe(false);
		expect(zotGuideVisible({ ...auto, bridgeDraftKey: "env:other" })).toBe(
			false,
		);
		expect(zotGuideVisible({ ...auto, bridgeDraftKey: KEY })).toBe(true);
	});

	it("never hides first use on a Zot without a coordinator", () => {
		// Older Zots that still need setup have no coordinator, so no composer.
		expect(
			zotGuideVisible({
				open: true,
				waitForComposer: true,
				draftKey: null,
				bridgeDraftKey: null,
			}),
		).toBe(true);
	});

	it("shows a replay at once, even without a composer (history, preferences)", () => {
		expect(
			zotGuideVisible({
				open: true,
				waitForComposer: false,
				draftKey: KEY,
				bridgeDraftKey: null,
			}),
		).toBe(true);
		expect(
			zotGuideVisible({
				open: false,
				waitForComposer: false,
				draftKey: KEY,
				bridgeDraftKey: KEY,
			}),
		).toBe(false);
	});

	const more = { focus: vi.fn() };
	const root = {
		querySelector: (selector: string) =>
			selector === '[data-zot-guide="continuity"]' ? more : null,
	};
	afterEach(() => more.focus.mockClear());

	it("returns lost focus to this Zot's composer first", () => {
		const focus = vi.fn();
		expect(
			restoreZotGuideFocus(true, root, { draftKey: KEY, focus }, KEY),
		).toBe("composer");
		expect(focus).toHaveBeenCalledOnce();
		expect(more.focus).not.toHaveBeenCalled();
	});

	it("falls back to the More button when another composer owns the bridge", () => {
		const focus = vi.fn();
		expect(
			restoreZotGuideFocus(true, root, { draftKey: "env:other", focus }, KEY),
		).toBe("more");
		expect(focus).not.toHaveBeenCalled();
		expect(more.focus).toHaveBeenCalledOnce();
		expect(
			restoreZotGuideFocus(true, null, { draftKey: null, focus: null }, KEY),
		).toBe("none");
	});

	it("leaves focus the user already moved", () => {
		const focus = vi.fn();
		expect(
			restoreZotGuideFocus(false, root, { draftKey: KEY, focus }, KEY),
		).toBe("kept");
		expect(focus).not.toHaveBeenCalled();
		expect(more.focus).not.toHaveBeenCalled();
	});
});
