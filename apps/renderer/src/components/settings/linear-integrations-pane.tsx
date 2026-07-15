import type { LinearConnection } from "@zuse/contracts";
import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";

import { getRpcClient } from "~/lib/rpc-client.ts";
import { Button } from "../ui/button.tsx";
import { Card } from "../ui/card.tsx";
import { Spinner } from "../ui/spinner.tsx";

export function LinearIntegrationsPane() {
	const [connections, setConnections] =
		useState<ReadonlyArray<LinearConnection> | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const client = await getRpcClient();
			setConnections(
				await Effect.runPromise(client["linear.listConnections"]({})),
			);
			setError(null);
		} catch (cause) {
			setConnections([]);
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const connect = async () => {
		if (busy !== null) return;
		setBusy("connect");
		setError(null);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(client["linear.connect"]({}));
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};

	const disconnect = async (connection: LinearConnection) => {
		if (
			!window.confirm(
				`Disconnect ${connection.workspaceName}? Existing local ticket context will remain.`,
			)
		)
			return;
		setBusy(connection.workspaceId);
		setError(null);
		try {
			const client = await getRpcClient();
			await Effect.runPromise(
				client["linear.disconnect"]({ workspaceId: connection.workspaceId }),
			);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<Card className="flex items-center justify-between gap-4 p-4">
				<div className="min-w-0">
					<h2 className="text-sm font-medium">Linear</h2>
					<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
						Select tickets when creating a chat. Ticket details, comments, and
						images are copied into the session workspace.
					</p>
				</div>
				<Button
					type="button"
					onClick={() => void connect()}
					disabled={busy !== null}
				>
					{busy === "connect" && <Spinner className="mr-2 size-3.5" />}
					Add workspace
				</Button>
			</Card>

			{error !== null && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}

			{connections === null ? (
				<div className="grid min-h-24 place-items-center">
					<Spinner className="size-4 text-muted-foreground" />
				</div>
			) : connections.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
					No Linear workspaces connected yet.
				</p>
			) : (
				<div className="flex flex-col gap-2">
					{connections.map((connection) => (
						<Card
							key={connection.workspaceId}
							className="flex items-center justify-between gap-4 p-4"
						>
							<div className="min-w-0">
								<p className="truncate text-sm font-medium">
									{connection.workspaceName}
								</p>
								<p className="truncate text-xs text-muted-foreground">
									{connection.viewerName} · {connection.viewerEmail}
								</p>
							</div>
							<Button
								type="button"
								variant="outline"
								disabled={busy !== null}
								onClick={() => void disconnect(connection)}
							>
								{busy === connection.workspaceId && (
									<Spinner className="mr-2 size-3.5" />
								)}
								Disconnect
							</Button>
						</Card>
					))}
				</div>
			)}
		</div>
	);
}
