import {
	CommandId,
	type PermissionDecision,
	type PermissionRequest,
	type SessionId,
} from "@zuse/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionSessionKey } from "~/lib/session-key";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

import {
	dispatchMobileSessionCommand,
	mobileClientBus,
	mobilePermissionsKey,
	registerMobileEnvironment,
} from "./mobile-client-bus";
import { appAtomRegistry } from "./registry";

/** Canonical permission projection exposed to the existing mobile atom UI. */
export const pendingBySessionAtom = Atom.make<
	Record<string, readonly PermissionRequest[]>
>({}).pipe(Atom.keepAlive);

const EMPTY_PENDING: readonly PermissionRequest[] = [];

export const pendingPermissionsAtom = Atom.family((key: string) =>
	Atom.make((get) => get(pendingBySessionAtom)[key] ?? EMPTY_PENDING),
);

const connections = new Map<
	string,
	Readonly<{ release: () => void; unsubscribe: () => void }>
>();

const normalizeRequests = (
	requests: readonly PermissionRequest[],
): PermissionRequest[] =>
	Array.from(
		new Map(requests.map((request) => [request.id, request])).values(),
	).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());

const project = (
	connKey: string,
	requests: readonly PermissionRequest[],
): void => {
	appAtomRegistry.update(pendingBySessionAtom, (state) => {
		const next = Object.fromEntries(
			Object.entries(state).filter(([key]) => !key.startsWith(`${connKey}:`)),
		);
		const grouped = new Map<string, PermissionRequest[]>();
		for (const request of requests) {
			const key = connectionSessionKey(connKey, request.sessionId);
			const entries = grouped.get(key) ?? [];
			entries.push(request);
			grouped.set(key, entries);
		}
		for (const [key, entries] of grouped)
			next[key] = normalizeRequests(entries);
		return next;
	});
};

/**
 * Retain the one environment-scoped ClientBus stream. Multiple session screens
 * on the same connection share this subscription and connection generation.
 */
export const retainPermissionConnection = (
	connKey: string,
	options: WsProtocolOptions,
): (() => void) => {
	const existing = connections.get(connKey);
	if (existing !== undefined) return () => undefined;
	const environmentId = registerMobileEnvironment(connKey, options);
	const key = mobilePermissionsKey(environmentId);
	const bus = mobileClientBus();
	const lease = bus.retain(key, { activation: "connect" });
	const publish = () => {
		const requests = Object.values(bus.snapshot(key)?.data?.requestsById ?? {});
		project(connKey, requests);
	};
	const unsubscribe = bus.subscribe(key, publish);
	connections.set(connKey, { release: lease.release, unsubscribe });
	publish();
	return () => {
		// Connection resources intentionally remain warm while the account is
		// active; resetPermissionsRuntime owns their deterministic teardown.
	};
};

export const resetPermissionsRuntime = async (): Promise<void> => {
	for (const connection of connections.values()) {
		connection.unsubscribe();
		connection.release();
	}
	connections.clear();
	appAtomRegistry.set(pendingBySessionAtom, {});
};

export const decidePermission = async (
	connKey: string,
	options: WsProtocolOptions,
	_sessionId: SessionId,
	requestId: string,
	decision: PermissionDecision,
): Promise<void> => {
	const environmentId = registerMobileEnvironment(connKey, options);
	const key = mobilePermissionsKey(environmentId);
	const bus = mobileClientBus();
	await dispatchMobileSessionCommand({
		kind: "permission.decide",
		commandId: CommandId.make(`permission-decide:${requestId}`),
		environmentId,
		resource: key,
		payload: { requestId, decision },
		retry: "never",
		createdAt: Date.now(),
	});
	bus.overlay(key, {
		update: (data) => {
			const requestsById = { ...data.requestsById };
			delete requestsById[requestId];
			return { requestsById };
		},
	});
};
