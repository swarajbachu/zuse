import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import { Effect } from "effect";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import {
	dispatchRetryableRpcCommand,
	getActiveEnvironmentId,
	getRpcClient,
	retryRendererRpcConnection,
	selectEnvironment,
	subscribeRendererRpcConnection,
} from "../lib/rpc-client.ts";

type RecoveryCopy = {
	readonly busy: boolean;
	readonly title: string;
	readonly description: string;
	readonly actions: boolean;
};

const recoveryCopy = (snapshot: ConnectionSnapshot): RecoveryCopy => {
	if (
		snapshot.status === "connecting" ||
		(snapshot.status === "reconnecting" && snapshot.attempt === 0)
	) {
		return {
			busy: true,
			title: "Connecting to your cloud machine…",
			description:
				"Zuse is securely opening the selected environment. Your local workspace remains available.",
			actions: false,
		};
	}
	if (snapshot.status === "offline") {
		return {
			busy: false,
			title: "You’re offline",
			description:
				"Reconnect to the internet to reach this cloud machine, or return to your Mac.",
			actions: true,
		};
	}
	if (snapshot.status === "blockedAuth") {
		return {
			busy: false,
			title: "Cloud authorization expired",
			description:
				"Zuse could not authorize this connection. Try again, or return to your Mac without changing the cloud machine.",
			actions: true,
		};
	}
	return {
		busy: false,
		title: "Cloud machine unavailable",
		description:
			"The machine is not reachable right now. Zuse will keep its files and state unchanged.",
		actions: true,
	};
};

export function CloudEnvironmentRecoverySurface({
	snapshot,
	onRetry,
	onReturnToLocal,
}: {
	readonly snapshot: ConnectionSnapshot;
	readonly onRetry: () => void;
	readonly onReturnToLocal: () => void;
}) {
	const copy = recoveryCopy(snapshot);
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (!copy.busy) headingRef.current?.focus();
	}, [copy.busy]);

	return (
		<div className="flex h-dvh w-screen items-center justify-center bg-background px-6 text-foreground">
			<main
				aria-busy={copy.busy}
				aria-live="polite"
				className="w-full max-w-md rounded-xl border border-border/70 bg-card p-6 shadow-sm"
			>
				<p className="font-medium text-muted-foreground text-sm">
					Cloud machine
				</p>
				<h1
					className="mt-2 font-semibold text-xl outline-none"
					ref={headingRef}
					tabIndex={-1}
				>
					{copy.title}
				</h1>
				<p className="mt-2 text-muted-foreground text-sm leading-6">
					{copy.description}
				</p>
				{copy.actions ? (
					<div className="mt-5 flex flex-wrap gap-2">
						<button
							className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground text-sm outline-none active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
							onClick={onRetry}
							type="button"
						>
							Try again
						</button>
						<button
							className="inline-flex min-h-11 items-center justify-center rounded-md px-4 font-medium text-sm outline-none active:scale-[0.97] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
							onClick={onReturnToLocal}
							type="button"
						>
							Return to this Mac
						</button>
					</div>
				) : null}
			</main>
		</div>
	);
}

const initialSnapshot = (environmentId: string): ConnectionSnapshot => ({
	key: `environment:${environmentId}`,
	status: "connecting",
	generation: 0,
	attempt: 0,
	error: null,
});

export function CloudEnvironmentGate({
	children,
}: {
	readonly children: ReactNode;
}) {
	const environmentId = getActiveEnvironmentId();
	const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(() =>
		environmentId === null ? null : initialSnapshot(environmentId),
	);

	useEffect(() => {
		if (environmentId === null) {
			setSnapshot(null);
			return;
		}
		const unsubscribe = subscribeRendererRpcConnection(setSnapshot);
		void dispatchRetryableRpcCommand("environment-gate:ping", async () => {
			const client = await getRpcClient();
			return Effect.runPromise(client["ping.ping"]({}));
		}).catch(() => undefined);
		return unsubscribe;
	}, [environmentId]);

	if (environmentId === null || snapshot?.status === "connected") {
		return children;
	}

	return (
		<CloudEnvironmentRecoverySurface
			onRetry={retryRendererRpcConnection}
			onReturnToLocal={() => void selectEnvironment(null)}
			snapshot={snapshot ?? initialSnapshot(environmentId)}
		/>
	);
}
