import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { composerSnapshotFromInput } from "../../src/composer/input-snapshot.ts";
import { parseComposerInput } from "../../src/composer/segment-parser.ts";
import {
	addChipEffect,
	chipExtensions,
} from "../../src/lib/codemirror/composer-chips.ts";
import {
	connectedOf,
	hasPluginConnectionLabel,
	pluginToolAddress,
} from "../../src/lib/connected-plugins.ts";

const meta = {
	kind: "plugin",
	pluginId: "linear",
	name: "Linear",
	domain: "linear.app",
} as const;

describe("@plugin mentions", () => {
	it("tell the agent which plugin to use, once per plugin", () => {
		const doc = "Ask @Linear and @Linear about open bugs";
		let state = EditorState.create({ doc, extensions: chipExtensions });
		for (const from of [4, 16])
			state = state.update({
				effects: addChipEffect.of({ from, to: from + 7, meta }),
			}).state;

		const input = parseComposerInput(state, "codex");

		expect(input.text).toBe(doc);
		expect(input.annotations).toHaveLength(1);
		expect(input.annotations[0]).toMatchObject({
			_tag: "context",
			id: "plugin:linear",
			label: "Linear",
		});
		const comment =
			"comment" in (input.annotations[0] ?? {})
				? String((input.annotations[0] as { comment: string }).comment)
				: "";
		expect(comment).toContain("plugins_search");
		expect(comment).toContain('"tools.linear."');

		// Editing a queued message restores the mention as a chip.
		const snapshot = composerSnapshotFromInput(input);
		expect(snapshot.chips.map((chip) => chip.meta)).toContainEqual({
			...meta,
			domain: "",
		});
	});
	it("keeps two account mentions distinct through queued-message editing", () => {
		const doc = "Ask @Linear / Work and @Linear / Personal";
		let state = EditorState.create({ doc, extensions: chipExtensions });
		for (const [name, connectionId] of [
			["Linear / Work", "work-id"],
			["Linear / Personal", "personal-id"],
		] as const) {
			const token = `@${name}`;
			const from = doc.indexOf(token);
			state = state.update({
				effects: addChipEffect.of({
					from,
					to: from + token.length,
					meta: { ...meta, name, connectionId },
				}),
			}).state;
		}
		const input = parseComposerInput(state, "zuse");
		expect(input.annotations.map((a) => a.id)).toEqual([
			"plugin:linear:work-id",
			"plugin:linear:personal-id",
		]);
		expect(input.annotations[0]).toMatchObject({
			comment: expect.stringContaining('"tools.linear.user.work-id."'),
		});
		const snapshot = composerSnapshotFromInput(input);
		expect(snapshot.doc).toBe(doc);
		expect(snapshot.chips.map((chip) => chip.meta)).toEqual([
			{ ...meta, name: "Linear / Work", connectionId: "work-id", domain: "" },
			{
				...meta,
				name: "Linear / Personal",
				connectionId: "personal-id",
				domain: "",
			},
		]);
	});
	it("lists enabled accounts separately and excludes unavailable connections", () => {
		const connection = {
			id: "work",
			pluginId: "linear",
			label: "Work",
			owner: "user" as const,
			state: "connected" as const,
			enabled: true,
			createdAt: 1,
		};
		expect(
			connectedOf({
				kind: "snapshot",
				tenantId: "personal:test",
				tenants: [],
				endpoint: "",
				catalog: [
					{
						id: "linear",
						name: "Linear",
						domain: "linear.app",
						description: "",
						category: null,
						featured: false,
					},
				],
				connections: [
					connection,
					{ ...connection, id: "personal", label: "Personal" },
					{ ...connection, id: "disabled", enabled: false },
					{ ...connection, id: "pending", state: "connecting" },
				],
			}).map((p) => [p.connectionId, p.name]),
		).toEqual([
			["work", "Linear / Work"],
			["personal", "Linear / Personal"],
		]);
	});
});

describe("plugin tool addresses", () => {
	it("name the plugin behind an agent's tool call", () => {
		expect(pluginToolAddress("tools.linear.user.c123.list_issues")).toEqual({
			pluginId: "linear",
			tool: "list_issues",
		});
		expect(pluginToolAddress("tools.linear")).toBeNull();
		expect(pluginToolAddress("")).toBeNull();
	});
});

describe("connection names", () => {
	it("rejects trimmed, case-insensitive duplicates only within the same plugin", () => {
		const connections = [{ pluginId: "linear", label: " Work " }];
		expect(hasPluginConnectionLabel(connections, "linear", "work")).toBe(true);
		expect(hasPluginConnectionLabel(connections, "linear", " WORK ")).toBe(
			true,
		);
		expect(hasPluginConnectionLabel(connections, "linear", "Personal")).toBe(
			false,
		);
		expect(hasPluginConnectionLabel(connections, "other", "Work")).toBe(false);
		expect(hasPluginConnectionLabel(connections, "linear", " ")).toBe(false);
	});
});
