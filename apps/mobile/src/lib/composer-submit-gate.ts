export type ComposerSubmitGate = {
	readonly tryRun: <A>(submit: () => Promise<A>) => Promise<A> | null;
};

export const createComposerSubmitGate = (): ComposerSubmitGate => {
	let active = false;
	return {
		tryRun: <A>(submit: () => Promise<A>): Promise<A> | null => {
			if (active) return null;
			active = true;
			let receipt: Promise<A>;
			try {
				receipt = submit();
			} catch (cause) {
				active = false;
				throw cause;
			}
			return receipt.finally(() => {
				active = false;
			});
		},
	};
};
