import { expect, test } from "vitest";
import { computerRows } from "../../../src/lib/computers";
import {
	decodeConnectionRecords,
	refreshConnectionDescriptor,
} from "../../../src/lib/connection-records";

const records = decodeConnectionRecords(
	["paired", "api", "manual"].map((source, index) => ({
		key: `${source}:one`,
		environmentId: "env-one",
		source,
		host: `route-${index}`,
		port: 8080,
		label: "whizzy’s MacBook Pro",
		updatedAt: index,
	})),
);
const record = (index: number) => {
	const value = records[index];
	if (!value) throw new Error("Missing connection fixture");
	return value;
};
test("combines local, remote and alternate routes and prefers the connected route", () => {
	const rows = computerRows(
		records,
		[{ environmentId: "env-one", label: "MacBook Pro", presence: "online" }],
		true,
		{ "api:one": { status: "connected" } },
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.connection?.key).toBe("api:one");
	expect(rows[0]?.environment?.environmentId).toBe("env-one");
});
test("does not merge different computers with identical names", () => {
	expect(
		computerRows(
			[],
			["env-one", "env-two"].map((environmentId) => ({
				environmentId,
				label: "MacBook Pro",
				presence: "offline",
			})),
			true,
			{},
		),
	).toHaveLength(2);
});
test("excludes cloud workspaces and signed-out account connections", () => {
	const cloud = { ...record(0), key: "cloud:one", source: "cloud" as const };
	expect(
		computerRows(
			[cloud, record(1)],
			[{ environmentId: "env-one", label: "Mac", presence: "online" }],
			false,
			{},
		),
	).toEqual([]);
});
test("learns authenticated identity for legacy manual connections", () => {
	const legacy = { ...record(2), environmentId: undefined };
	const updated = refreshConnectionDescriptor(
		[legacy],
		legacy.key,
		legacy.label,
		undefined,
		123,
		"env-one",
	);
	expect(updated[0]?.environmentId).toBe("env-one");
	expect(computerRows([...updated, record(0)], [], false, {})).toHaveLength(1);
});
