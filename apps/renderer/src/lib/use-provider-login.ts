import "@zuse/i18n/english/providers";
import type { ProviderId, SessionId } from "@zuse/contracts";
import { message } from "@zuse/i18n";
import { useEffect, useRef } from "react";

import { createAtomStore } from "../state/atom-store.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { formatError } from "./format-error.ts";
import { openExternal } from "./platform-capabilities.ts";
import { refreshProviderMetadata } from "./refresh-provider-metadata.ts";
import { runtimeOperationClient } from "./runtime-operation-client.ts";
import { StreamOperationOwner } from "./stream-operation.ts";

export { openExternal } from "./platform-capabilities.ts";

export type ProviderLoginState =
	| { readonly kind: "idle" }
	| {
			readonly kind: "waiting";
			readonly url: string | null;
			readonly output?: string;
	  }
	| { readonly kind: "success" }
	| { readonly kind: "failed"; readonly reason: string };

const PROVIDERS_WITH_INLINE_LOGIN: ReadonlySet<ProviderId> =
	new Set<ProviderId>(["claude", "codex", "grok"]);

export const supportsProviderLogin = (providerId: ProviderId): boolean =>
	PROVIDERS_WITH_INLINE_LOGIN.has(providerId);

const IDLE_LOGIN: ProviderLoginState = { kind: "idle" };
const loginStore = createAtomStore<{
	stateByKey: Record<string, ProviderLoginState>;
	/** Epoch ms of the last in-app sign-in that succeeded, per computer and provider. */
	signedInAtByKey: Record<string, number>;
}>(() => ({ stateByKey: {}, signedInAtByKey: {} }));
const owners = new Map<string, StreamOperationOwner>();
const keyFor = (
	environmentId: string,
	providerId: ProviderId,
	accountId?: string,
) =>
	JSON.stringify(
		accountId
			? [environmentId, providerId, accountId]
			: [environmentId, providerId],
	);
const setState = (key: string, state: ProviderLoginState) =>
	loginStore.setState((current) => {
		const stateByKey = { ...current.stateByKey };
		if (state.kind === "idle") delete stateByKey[key];
		else stateByKey[key] = state;
		return {
			stateByKey,
			signedInAtByKey:
				state.kind === "success"
					? { ...current.signedInAtByKey, [key]: Date.now() }
					: current.signedInAtByKey,
		};
	});
const cancelProviderLogin = (key: string) => {
	owners.get(key)?.cancel();
	owners.delete(key);
	setState(key, IDLE_LOGIN);
};
const startProviderLogin = async (
	environmentId: string,
	providerId: ProviderId,
	accountId?: string,
	sessionId?: SessionId,
) => {
	const key = keyFor(
		environmentId,
		providerId,
		accountId ?? (sessionId ? `session:${sessionId}` : undefined),
	);
	if (loginStore.getState().stateByKey[key]?.kind === "waiting") return;
	cancelProviderLogin(key);
	const owner = new StreamOperationOwner();
	owners.set(key, owner);
	setState(key, { kind: "waiting", url: null });
	let completed = false;
	let output = "";
	let url: string | null = null;
	await owner.run(
		async () =>
			(await runtimeOperationClient(environmentId))["provider.startLogin"]({
				providerId,
				...(accountId ? { accountId } : {}),
				...(sessionId ? { sessionId } : {}),
			}),
		async (event) => {
			if (event._tag === "url") {
				if (providerId !== "grok") void openExternal(event.url);
				url = event.url;
				setState(key, { kind: "waiting", url, output });
			} else if (event._tag === "log" && providerId === "codex") {
				output = `${output}\n${event.text}`.slice(-2000).trim();
				setState(key, { kind: "waiting", url, output });
			} else if (event._tag === "done") {
				completed = true;
				if (!event.ok) {
					setState(key, {
						kind: "failed",
						reason: event.reason ?? message("providers:sign_in_failed"),
					});
					return;
				}
				await refreshProviderMetadata(environmentId);
				if (owners.get(key) !== owner) return;
				setState(key, { kind: "success" });
				owner.resetAfter(() => {
					owners.delete(key);
					setState(key, IDLE_LOGIN);
				});
			}
		},
		(error) => {
			completed = true;
			setState(key, { kind: "failed", reason: formatError(error) });
		},
	);
	if (!completed && owners.get(key) === owner)
		setState(key, {
			kind: "failed",
			reason: message("providers:sign_in_incomplete"),
		});
	if (
		owners.get(key) === owner &&
		loginStore.getState().stateByKey[key]?.kind === "failed"
	)
		owners.delete(key);
};

/**
 * Shared one-click provider sign-in state machine. Subscribes to
 * `provider.startLogin`, which spawns the provider's `login` subcommand
 * server-side and streams progress. The first `url` event opens the OAuth page
 * when the provider CLI does not own browser launch; the terminal `done` event
 * resolves to success/failure.
 *
 * The attempt is owned per computer and provider, not per component: switching settings
 * rows or leaving the page keeps the sign-in running and its status visible.
 * Only an explicit cancel interrupts the stream, which closes the server-side
 * scope and SIGTERMs the child process.
 *
 * Used by both the provider settings card and the composer sign-in tray so
 * the flow (and its copy) stays identical wherever a user signs in. Each
 * mounted caller's `onSuccess` fires when it observes the attempt succeed.
 */
export function useProviderLogin(
	providerId: ProviderId,
	opts?: {
		readonly onSuccess?: () => void;
		readonly environmentId?: string;
		readonly accountId?: string;
		readonly sessionId?: SessionId;
	},
): {
	readonly state: ProviderLoginState;
	/** Epoch ms of the last successful in-app sign-in; 0 when none this run. */
	readonly signedInAt: number;
	readonly start: () => Promise<void>;
	readonly cancel: () => void;
} {
	const active = useEnvironmentCatalogStore((s) => s.activeEnvironmentId);
	const environmentId = opts?.environmentId ?? active;
	const key = keyFor(
		environmentId,
		providerId,
		opts?.accountId ??
			(opts?.sessionId ? `session:${opts.sessionId}` : undefined),
	);
	const state = loginStore((current) => current.stateByKey[key] ?? IDLE_LOGIN);
	const signedInAt = loginStore((current) => current.signedInAtByKey[key] ?? 0);
	const onSuccessRef = useRef(opts?.onSuccess);
	onSuccessRef.current = opts?.onSuccess;
	const previousKind = useRef(state.kind);
	useEffect(() => {
		if (state.kind === "success" && previousKind.current !== "success")
			onSuccessRef.current?.();
		previousKind.current = state.kind;
	}, [state.kind]);

	return {
		state,
		signedInAt,
		start: () =>
			startProviderLogin(
				environmentId,
				providerId,
				opts?.accountId,
				opts?.sessionId,
			),
		cancel: () => cancelProviderLogin(key),
	};
}
