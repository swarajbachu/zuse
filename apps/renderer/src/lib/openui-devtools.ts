/**
 * `@openuidev/react-lang` auto-mounts its Inspect widget in development builds
 * when first imported. Generated transcript blocks are chat content, not an
 * OpenUI app, so claim the auto-mount flag before the library evaluates.
 * Import this module before `@openuidev/react-lang`.
 */
(globalThis as Record<symbol, unknown>)[
	Symbol.for("openui.devtools.autoMount")
] = true;
