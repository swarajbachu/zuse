import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import {
	type BulkDisclosure,
	nextLocalDisclosure,
	resolveLocalDisclosure,
	useLocalTranscriptDisclosure,
	useTranscriptDisclosure,
	useTranscriptDisclosures,
} from "../../src/store/transcript-disclosures.ts";

function Disclosure({ id, live = false }: { id: string; live?: boolean }) {
	const [open] = useTranscriptDisclosure(
		`${id}:${live ? "live" : "settled"}`,
		live,
	);
	return (
		<button type="button" aria-expanded={open}>
			Activity
		</button>
	);
}
function LocalDisclosure({ defaultOpen = false }: { defaultOpen?: boolean }) {
	const [open, toggle] = useLocalTranscriptDisclosure(defaultOpen);
	return (
		<button type="button" aria-expanded={open} onClick={toggle}>
			Local
		</button>
	);
}
beforeEach(() => useTranscriptDisclosures.setState({ byKey: {}, bulk: null }));
it("keeps a manual close and a manual reopen across row remounts", () => {
	const render = () => renderToStaticMarkup(<Disclosure id="row" live />);
	expect(render()).toContain('aria-expanded="true"');
	useTranscriptDisclosures.getState().toggle("row:live", true);
	expect(render()).toContain('aria-expanded="false"');
	expect(render()).toContain('aria-expanded="false"');
	useTranscriptDisclosures.getState().toggle("row:live", true);
	expect(render()).toContain('aria-expanded="true"');
});
it("collapses when a turn finishes even if live activity was explicitly opened", () => {
	const store = useTranscriptDisclosures.getState();
	store.toggle("row:live", true);
	store.toggle("row:live", true);
	expect(renderToStaticMarkup(<Disclosure id="row" />)).toContain(
		'aria-expanded="false"',
	);
	store.toggle("row:settled", false);
	expect(renderToStaticMarkup(<Disclosure id="row" />)).toContain(
		'aria-expanded="true"',
	);
	expect(renderToStaticMarkup(<Disclosure id="another-row" />)).toContain(
		'aria-expanded="false"',
	);
});
it("bounds retained disclosure state", () => {
	for (let i = 0; i < 2050; i++)
		useTranscriptDisclosures.getState().toggle(String(i), false);
	expect(Object.keys(useTranscriptDisclosures.getState().byKey)).toHaveLength(
		2048,
	);
	expect(useTranscriptDisclosures.getState().byKey["2049"]).toBe(true);
});
it("toggle all expands every keyed row first, then collapses them all", () => {
	const store = useTranscriptDisclosures.getState();
	store.toggle("live:live", true); // manually closed a live group
	store.toggleAll();
	expect(renderToStaticMarkup(<Disclosure id="row" />)).toContain(
		'aria-expanded="true"',
	);
	expect(renderToStaticMarkup(<Disclosure id="live" live />)).toContain(
		'aria-expanded="true"',
	);
	store.toggleAll();
	expect(renderToStaticMarkup(<Disclosure id="row" />)).toContain(
		'aria-expanded="false"',
	);
	expect(renderToStaticMarkup(<Disclosure id="live" live />)).toContain(
		'aria-expanded="false"',
	);
	expect(useTranscriptDisclosures.getState().byKey).toEqual({});
});
it("lets a single row be toggled against the bulk state", () => {
	const store = useTranscriptDisclosures.getState();
	store.toggleAll();
	store.toggle("row:settled", false);
	expect(renderToStaticMarkup(<Disclosure id="row" />)).toContain(
		'aria-expanded="false"',
	);
	expect(renderToStaticMarkup(<Disclosure id="other" />)).toContain(
		'aria-expanded="true"',
	);
	store.toggleAll();
	expect(renderToStaticMarkup(<Disclosure id="row" />)).toContain(
		'aria-expanded="false"',
	);
	expect(renderToStaticMarkup(<Disclosure id="other" />)).toContain(
		'aria-expanded="false"',
	);
});
it("drives keyless rows from toggle all while their own clicks still work", () => {
	const store = useTranscriptDisclosures.getState();
	const bulk = () => useTranscriptDisclosures.getState().bulk;
	let own: BulkDisclosure | null = null;
	const click = () => {
		own = nextLocalDisclosure(own, bulk(), false);
	};
	const current = () => resolveLocalDisclosure(own, bulk(), false);
	expect(current()).toEqual({ open: false, viaBulk: false });
	click();
	expect(current()).toEqual({ open: true, viaBulk: false });
	store.toggleAll(); // expand all keeps it open, now owned by the bulk press
	expect(current()).toEqual({ open: true, viaBulk: true });
	click();
	expect(current()).toEqual({ open: false, viaBulk: false });
	store.toggleAll(); // collapse all
	expect(current()).toEqual({ open: false, viaBulk: true });
	store.toggleAll(); // expand all again overrides the earlier click
	expect(current()).toEqual({ open: true, viaBulk: true });
	click();
	click();
	expect(current()).toEqual({ open: true, viaBulk: false });
});
it("mounts keyless rows in the current bulk state", () => {
	useTranscriptDisclosures.getState().toggleAll();
	expect(renderToStaticMarkup(<LocalDisclosure />)).toContain(
		'aria-expanded="true"',
	);
	useTranscriptDisclosures.getState().toggleAll();
	expect(renderToStaticMarkup(<LocalDisclosure defaultOpen />)).toContain(
		'aria-expanded="false"',
	);
});
