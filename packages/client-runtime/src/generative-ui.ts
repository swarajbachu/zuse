/** Only the app-owned tool name marks a call as a generated UI block. */
export const isEmitUiTool = (name: string): boolean =>
	/^(?:emit_ui|(?:mcp__)?zuse(?:__|\.|_|\/)emit_ui)$/i.test(name);
