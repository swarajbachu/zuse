/** Batch visual subscribers only; event processing and command receipts stay immediate. */
export function subscribeOnAnimationFrame(
	subscribe: (listener: () => void) => () => void,
	listener: () => void,
): () => void {
	if (typeof requestAnimationFrame !== "function") return subscribe(listener);
	let frame: number | null = null;
	const unsubscribe = subscribe(() => {
		if (frame !== null) return;
		frame = requestAnimationFrame(() => {
			frame = null;
			listener();
		});
	});
	return () => {
		unsubscribe();
		if (frame !== null) cancelAnimationFrame(frame);
	};
}
