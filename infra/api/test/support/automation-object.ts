import type {
	WebSocket as CloudflareWebSocket,
	DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { vi } from "vitest";
import {
	AutomationDurableObjectCore,
	type AutomationObjectState,
} from "../../src/automation-durable-object.ts";
import { testCipher } from "../slack/test-support.ts";

export const automationObjectFixture = (initialTime = Date.now()) => {
	let time = initialTime;
	const records = new Map<string, unknown>();
	let alarm: number | null = null;
	const sockets: { socket: CloudflareWebSocket; tags: string[] }[] = [];
	const storage: AutomationObjectState["storage"] = {
		list: async <T>() => new Map(records) as Map<string, T>,
		put: async (key, value) => {
			records.set(key, structuredClone(value));
		},
		delete: async (key) => records.delete(key),
		setAlarm: async (value) => {
			alarm = value;
		},
		deleteAlarm: async () => {
			alarm = null;
		},
		transaction: async (callback) => {
			const before = structuredClone(records);
			const oldAlarm = alarm;
			try {
				return await callback(storage);
			} catch (error) {
				records.clear();
				for (const [key, value] of before) records.set(key, value);
				alarm = oldAlarm;
				throw error;
			}
		},
	};
	let gate = Promise.resolve();
	const state: AutomationObjectState = {
		storage,
		blockConcurrencyWhile: (callback) => {
			const result = gate.then(callback);
			gate = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		getWebSockets: (tag) =>
			sockets
				.filter((item) => !tag || item.tags.includes(tag))
				.map((item) => item.socket),
		acceptWebSocket: (socket, tags = []) => {
			sockets.push({ socket, tags });
		},
	};
	const wake = vi.fn(async (_workspaceId: string, _accountId: string) => true);
	const core = new AutomationDurableObjectCore(state, {
		cipher: testCipher,
		wake,
		now: () => time,
	});
	return {
		core,
		state,
		records,
		wake,
		setTime: (value: number) => {
			time = value;
		},
		get alarm() {
			return alarm;
		},
		request: async (path: string, body: Record<string, unknown> = {}) =>
			core.fetch(
				new Request(`https://automation.internal/${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ accountId: "account-a", ...body }),
				}),
			),
	};
};
export const automationNamespaceFixture = (now = Date.now()) => {
	const objects = new Map<string, ReturnType<typeof automationObjectFixture>>();
	const object = (accountId: string) => {
		let current = objects.get(accountId);
		if (!current) {
			current = automationObjectFixture(now);
			objects.set(accountId, current);
		}
		return current;
	};
	const namespace = {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			fetch: (request: Request | string, init?: RequestInit) =>
				object(id).core.fetch(
					typeof request === "string" ? new Request(request, init) : request,
				),
		}),
	} as unknown as DurableObjectNamespace;
	return { namespace, objects, object };
};
