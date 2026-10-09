import { useCallback, useEffect, useRef, useState } from "react";
import { organizationErrorMessage } from "../lib/organization-error.ts";
import { rendererAccountSnapshot } from "../lib/renderer-account.ts";

export type StillCurrent = () => boolean;

/**
 * Runs one organization action at a time and drops results once the caller
 * unmounts or the signed-in account changes underneath it.
 */
export function useOrganizationAction() {
	const generation = useRef(0);
	const inFlight = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(
		() => () => {
			generation.current++;
		},
		[],
	);
	const guard = useCallback((): StillCurrent => {
		const epoch = generation.current;
		const account = rendererAccountSnapshot();
		return () =>
			epoch === generation.current && account === rendererAccountSnapshot();
	}, []);
	const run = async (action: (current: StillCurrent) => Promise<void>) => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError(null);
		const current = guard();
		try {
			await action(current);
		} catch (cause) {
			if (current()) setError(organizationErrorMessage(cause));
		} finally {
			inFlight.current = false;
			if (current()) setBusy(false);
		}
	};
	return { busy, error, setError, guard, run };
}
