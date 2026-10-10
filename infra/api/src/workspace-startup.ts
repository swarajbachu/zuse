import type { DurableObjectState } from "@cloudflare/workers-types";

export interface WorkspaceStartupNamespace {
	readonly idFromName: (name: string) => unknown;
	readonly get: (id: unknown) => {
		readonly fetch: (request: Request) => Promise<Response>;
	};
}

export const scheduleWorkspaceStartup = async (
	namespace: WorkspaceStartupNamespace,
	workspaceId: string,
): Promise<void> => {
	const response = await namespace.get(namespace.idFromName(workspaceId)).fetch(
		new Request("https://workspace-startup.internal/schedule", {
			method: "POST",
			body: JSON.stringify({ workspaceId }),
		}),
	);
	if (!response.ok) throw new Error("workspace startup scheduling failed");
};

interface StartupRequest {
	readonly workspaceId: string;
	readonly revision: string;
}

/** PostgreSQL owns progress; the object retains only its durable dispatch pointer. */
export type WorkspaceStartupOutcome =
	| { readonly kind: "complete" }
	| { readonly kind: "due"; readonly dueAtMs: number }
	| {
			readonly kind: "blocked";
			readonly prerequisite: string;
			readonly wakeSource: "workspace-request" | "runtime-callback";
			readonly dueAtMs?: number;
	  };

/** Owns execution only; the existing Postgres reconciler owns lifecycle and leases. */
export class WorkspaceStartupTask {
	constructor(
		private readonly state: DurableObjectState,
		private readonly reconcile: (
			workspaceId: string,
		) => Promise<WorkspaceStartupOutcome>,
	) {}

	async fetch(request: Request): Promise<Response> {
		if (
			request.method !== "POST" ||
			new URL(request.url).pathname !== "/schedule"
		)
			return new Response(null, { status: 404 });
		const body = (await request.json()) as { workspaceId?: unknown };
		if (typeof body.workspaceId !== "string" || !body.workspaceId)
			return new Response(null, { status: 400 });
		const pending: StartupRequest = {
			workspaceId: body.workspaceId,
			revision: crypto.randomUUID(),
		};
		await this.state.storage.transaction(async (storage) => {
			await storage.put("pending", pending);
			// Persist work and its alarm together before acknowledging the caller.
			const alarm = await storage.getAlarm();
			if (alarm === null || alarm > Date.now())
				await storage.setAlarm(Date.now());
		});
		return new Response(null, { status: 202 });
	}

	async alarm(alarmInfo?: { readonly retryCount: number }): Promise<void> {
		const pending = await this.state.storage.get<StartupRequest>("pending");
		if (!pending) return;
		// Await the entire operation in the alarm, never in HTTP waitUntil.
		// Automatic retries are bounded. Renew the alarm before they run out.
		let outcome: WorkspaceStartupOutcome;
		try {
			outcome = await this.reconcile(pending.workspaceId);
		} catch (error) {
			if ((alarmInfo?.retryCount ?? 0) < 5) throw error;
			await this.state.storage.transaction(async (storage) => {
				// Keep a newer request's earlier alarm rather than delaying it.
				if ((await storage.getAlarm()) === null)
					await storage.setAlarm(Date.now() + 30_000);
			});
			return;
		}
		await this.state.storage.transaction(async (storage) => {
			const current = await storage.get<StartupRequest>("pending");
			if (current?.revision === pending.revision) {
				if (outcome.kind === "complete") {
					await storage.delete("pending");
				} else if (outcome.dueAtMs !== undefined) {
					// A lease collision or stale due timestamp must not create an alarm spin.
					const dueAtMs = Math.max(Date.now() + 100, outcome.dueAtMs);
					const alarm = await storage.getAlarm();
					if (alarm === null || alarm > dueAtMs)
						await storage.setAlarm(dueAtMs);
				}
				// Event-blocked work retains its pointer; its named wake source schedules it.
			} else if (current && (await storage.getAlarm()) === null) {
				await storage.setAlarm(Date.now());
			}
		});
	}
}
