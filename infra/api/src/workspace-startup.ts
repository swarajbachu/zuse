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

/** Owns execution only; the existing Postgres reconciler owns lifecycle and leases. */
export class WorkspaceStartupTask {
	constructor(
		private readonly state: DurableObjectState,
		private readonly reconcile: (workspaceId: string) => Promise<void>,
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
			if ((await storage.getAlarm()) === null)
				await storage.setAlarm(Date.now());
		});
		return new Response(null, { status: 202 });
	}

	async alarm(): Promise<void> {
		const pending = await this.state.storage.get<StartupRequest>("pending");
		if (!pending) return;
		// Await the entire operation in the alarm, never in HTTP waitUntil.
		// Throwing retains the request for Cloudflare's alarm retries.
		await this.reconcile(pending.workspaceId);
		await this.state.storage.transaction(async (storage) => {
			const current = await storage.get<StartupRequest>("pending");
			if (current?.revision === pending.revision) {
				await storage.delete("pending");
			} else if (current && (await storage.getAlarm()) === null) {
				await storage.setAlarm(Date.now());
			}
		});
	}
}
