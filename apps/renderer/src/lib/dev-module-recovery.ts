const reloadKey = "zuse.dev.preload-reload-at";
const cooldownMs = 30_000;

export function isModuleFetchError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
			error.message,
		)
	);
}

type RecoveryHost = {
	readonly storage: Pick<Storage, "getItem" | "setItem">;
	readonly now: () => number;
	readonly ready: () => Promise<boolean>;
	readonly reload: () => void;
	readonly delay: () => Promise<void>;
};

/** One bounded reload across documents; never retry module evaluation in-place. */
export function createModuleRecovery(host: RecoveryHost) {
	let pending = false;
	return (error: unknown): boolean => {
		if (!isModuleFetchError(error)) return false;
		if (pending) return true;
		try {
			const previous = host.storage.getItem(reloadKey);
			if (previous !== null && host.now() - Number(previous) < cooldownMs)
				return false;
			// Persist before polling so a second document cannot start a reload loop.
			host.storage.setItem(reloadKey, String(host.now()));
		} catch {
			// Without a cross-document budget, automatic reload is unsafe.
			return false;
		}
		pending = true;
		void (async () => {
			try {
				for (let attempt = 0; attempt < 10; attempt++) {
					await host.delay();
					if (await host.ready()) {
						host.reload();
						return;
					}
				}
			} catch {
				// Recovery must not replace the original failure with a rejection.
			} finally {
				pending = false;
			}
		})();
		return true;
	};
}

export const recoverDevModule = import.meta.env.DEV
	? createModuleRecovery({
			storage: {
				getItem: (key) => window.sessionStorage.getItem(key),
				setItem: (key, value) => window.sessionStorage.setItem(key, value),
			},
			now: Date.now,
			delay: () => new Promise((resolve) => setTimeout(resolve, 500)),
			ready: async () => {
				try {
					const response = await fetch("/@vite/client", {
						cache: "no-store",
						signal: AbortSignal.timeout(1000),
					});
					return response.ok;
				} catch {
					return false;
				}
			},
			reload: () => window.location.reload(),
		})
	: () => false;
