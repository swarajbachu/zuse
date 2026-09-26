import type { ApiEnvironmentRecord } from "@zuse/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { groupHostedComputers } from "../lib/hosted-computer-catalog.ts";
import { listHostedEnvironments } from "../lib/hosted-connect.ts";

/** Account discovery never activates a computer or starts a cloud workspace. */
export function useHostedComputers(enabled = true) {
	const [computers, setComputers] = useState<
		ReadonlyArray<ApiEnvironmentRecord>
	>([]);
	const [loading, setLoading] = useState(enabled);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const refresh = useCallback(() => setAttempt((value) => value + 1), []);
	useEffect(() => {
		if (!enabled) return;
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [enabled, refresh]);
	useEffect(() => {
		if (!enabled) {
			setLoading(false);
			return;
		}
		let active = true;
		setLoading(true);
		setFailed(false);
		void listHostedEnvironments()
			.then(
				(result) => {
					if (active)
						setComputers(
							result.environments.filter(
								(computer) => computer.providerKind !== "cloud",
							),
						);
				},
				() => {
					if (active) setFailed(true);
				},
			)
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [enabled, attempt]);
	const groups = useMemo(() => groupHostedComputers(computers), [computers]);
	return {
		computers: groups.map((group) => group.computer),
		groups,
		loading,
		failed,
		refresh,
	};
}
