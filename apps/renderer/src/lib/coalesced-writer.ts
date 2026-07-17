export type CoalescedWriter<Value> = {
	readonly schedule: (value: Value) => void;
	readonly flush: () => void;
	readonly cancel: () => void;
};

export type CoalescedWriterScheduler = {
	readonly schedule: (run: () => void) => unknown;
	readonly cancel: (handle: unknown) => void;
};

export const makeCoalescedWriter = <Value>(
	write: (value: Value) => void,
	scheduler: CoalescedWriterScheduler,
): CoalescedWriter<Value> => {
	let pending: Value | undefined;
	let hasPending = false;
	let handle: unknown | null = null;

	const commit = () => {
		handle = null;
		if (!hasPending) return;
		const value = pending as Value;
		pending = undefined;
		hasPending = false;
		write(value);
	};

	return {
		schedule: (value) => {
			pending = value;
			hasPending = true;
			handle ??= scheduler.schedule(commit);
		},
		flush: () => {
			if (handle !== null) scheduler.cancel(handle);
			commit();
		},
		cancel: () => {
			if (handle !== null) scheduler.cancel(handle);
			handle = null;
			pending = undefined;
			hasPending = false;
		},
	};
};
