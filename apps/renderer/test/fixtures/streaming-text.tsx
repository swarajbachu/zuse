import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useStreamingText } from "../../src/hooks/use-streaming-text.ts";

export async function run() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let update: (text: string) => void = () => {};
	function Fixture() {
		const [text, setText] = useState("History.");
		update = setText;
		return createElement("p", null, useStreamingText(text, true));
	}
	flushSync(() => root.render(createElement(Fixture)));
	if (host.textContent !== "History.") throw new Error("History was delayed");
	const lengths: number[] = [];
	const observer = new MutationObserver(() =>
		lengths.push(host.textContent?.length ?? 0),
	);
	observer.observe(host, {
		subtree: true,
		characterData: true,
		childList: true,
	});
	const final = `History.${" smoothly arriving text".repeat(12)}`;
	const start = performance.now();
	flushSync(() => update(final));
	await new Promise((resolve) => setTimeout(resolve, 250));
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	try {
		if (host.textContent !== final) throw new Error("Stream did not catch up");
		if (!reduced && new Set(lengths).size < 3)
			throw new Error("Chunk painted in one jump");
		return {
			reduced,
			paintedLengths: lengths,
			elapsedMs: performance.now() - start,
		};
	} finally {
		observer.disconnect();
		root.unmount();
		host.remove();
	}
}
