/**
 * Node/vitest fallback for ./batching.native.ts — tests drive the registry
 * directly and need no React batching, so this simply invokes the update.
 */
export const batchReactUpdates = (update: () => void): void => {
	update();
};
