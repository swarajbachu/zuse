// Browser-targeted dependencies such as xterm use `self` in their UMD entry.
// Vitest runs renderer store tests in Node, where the equivalent global is
// `globalThis`.
if (!("self" in globalThis)) {
	Object.defineProperty(globalThis, "self", {
		configurable: true,
		value: globalThis,
	});
}
