import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityLoader } from "../../src/components/ui/activity-loader.tsx";
import {
	ACTIVITY_SCENE_BY_STATE,
	AgentActivityOrb,
} from "../../src/components/ui/agent-activity-orb.tsx";
import {
	ACTIVITY_LOADER_SCENES,
	type ActivityLoaderContext,
	type ActivityLoaderScene,
	drawActivityLoaderScene,
} from "../../src/lib/activity-loader-scenes.ts";

type Mark = {
	readonly kind: "dot" | "glyph" | "line";
	readonly x: number;
	readonly y: number;
	readonly alpha: number;
};

function recordFrame(
	scene: ActivityLoaderScene,
	size: number,
	time = 1_200,
): { marks: Mark[]; cleared: number[][] } {
	const marks: Mark[] = [];
	const cleared: number[][] = [];
	let cursor = { x: 0, y: 0 };
	let alpha = 1;
	const ctx = {
		get globalAlpha() {
			return alpha;
		},
		set globalAlpha(value: number) {
			alpha = value;
		},
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		lineCap: "butt",
		font: "",
		textAlign: "start",
		textBaseline: "alphabetic",
		setTransform: () => {},
		clearRect: (...args: number[]) => cleared.push(args),
		beginPath: () => {},
		fill: () => {},
		stroke: () => {},
		arc: (x: number, y: number) => {
			marks.push({ kind: "dot", x, y, alpha });
		},
		fillText: (_text: string, x: number, y: number) => {
			marks.push({ kind: "glyph", x, y, alpha });
		},
		moveTo: (x: number, y: number) => {
			cursor = { x, y };
		},
		lineTo: (x: number, y: number) => {
			marks.push({ kind: "line", x: cursor.x, y: cursor.y, alpha: 1 });
			marks.push({ kind: "line", x, y, alpha });
		},
	} as unknown as ActivityLoaderContext;
	drawActivityLoaderScene(ctx, scene, {
		time,
		size,
		pixelRatio: 2,
		color: "rgb(1, 2, 3)",
	});
	return { marks, cleared };
}

describe("activity loader scenes", () => {
	it.each(
		ACTIVITY_LOADER_SCENES.flatMap((scene) =>
			[14, 20, 32, 64].map((size) => [scene, size] as const),
		),
	)("%s at %ipx stays inside its square", (scene, size) => {
		const { marks, cleared } = recordFrame(scene, size);
		expect(cleared).toEqual([[0, 0, size * 2, size * 2]]);
		expect(marks.length).toBeGreaterThan(0);
		for (const mark of marks) {
			expect(Number.isFinite(mark.x) && Number.isFinite(mark.y)).toBe(true);
			expect(Math.abs(mark.x)).toBeLessThanOrEqual(1.05);
			expect(Math.abs(mark.y)).toBeLessThanOrEqual(1.05);
			expect(mark.alpha).toBeGreaterThanOrEqual(0);
			expect(mark.alpha).toBeLessThanOrEqual(1);
		}
	});

	it.each(ACTIVITY_LOADER_SCENES)("%s moves over time", (scene) => {
		const before = recordFrame(scene, 20, 1_200).marks;
		const after = recordFrame(scene, 20, 1_450).marks;
		expect(after).not.toEqual(before);
	});

	it("draws the donut as ASCII only when there is room for glyphs", () => {
		const kinds = (size: number) =>
			new Set(recordFrame("donut", size).marks.map((mark) => mark.kind));
		expect(kinds(48)).toEqual(new Set(["glyph"]));
		expect(kinds(20)).toEqual(new Set(["dot"]));
	});

	it("thins the Möbius band at inline sizes", () => {
		expect(recordFrame("mobius", 20).marks.length).toBeLessThan(
			recordFrame("mobius", 32).marks.length,
		);
	});
});

describe("ActivityLoader", () => {
	it("is an image only when it has its own accessible name", () => {
		const labelled = renderToStaticMarkup(
			<ActivityLoader scene="helix" size={20} label="Agent is editing" />,
		);
		expect(labelled).toContain('role="img"');
		expect(labelled).toContain('aria-label="Agent is editing"');

		const decorative = renderToStaticMarkup(
			<ActivityLoader scene="helix" size={20} />,
		);
		expect(decorative).toContain('aria-hidden="true"');
		expect(decorative).not.toContain("role=");
	});

	it("gives each agent activity a distinct scene", () => {
		expect(ACTIVITY_SCENE_BY_STATE).toEqual({
			working: "mobius",
			composing: "mobius",
			searching: "wave",
			shaping: "helix",
			solving: "donut",
			listening: "dither",
			delegating: "vortex",
		});
		const markup = renderToStaticMarkup(
			<AgentActivityOrb state="delegating" />,
		);
		expect(markup).toContain('data-activity-loader="vortex"');
		expect(markup).toContain("width:20px");
	});
});
