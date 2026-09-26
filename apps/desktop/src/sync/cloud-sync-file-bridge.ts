import { randomUUID } from "node:crypto";

/** Correlates bounded gateway reads with the renderer that owns cloud access. */
export class CloudSyncFileBridge {
	private readonly pending = new Map<string, (value: unknown) => void>();
	constructor(
		private readonly send: (request: {
			requestId: string;
			workspaceId: string;
			path: string;
		}) => void,
	) {}
	read(
		workspaceId: string,
		path: string,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		return new Promise((resolve, reject) => {
			const requestId = randomUUID();
			const finish = (value: unknown) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.pending.delete(requestId);
				if (value instanceof Uint8Array && value.byteLength <= 4 * 1024 * 1024)
					resolve(value);
				else
					reject(
						new Error(
							typeof value === "string"
								? value
								: "Invalid snapshot file response.",
						),
					);
			};
			const abort = () => finish("Sync cancelled.");
			const timer = setTimeout(
				() => finish("Workspace gateway file read timed out."),
				30000,
			);
			this.pending.set(requestId, finish);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			try {
				this.send({ requestId, workspaceId, path });
			} catch {
				finish("Workspace renderer is unavailable.");
			}
		});
	}
	complete(requestId: unknown, value: unknown): void {
		if (typeof requestId === "string") this.pending.get(requestId)?.(value);
	}
}
