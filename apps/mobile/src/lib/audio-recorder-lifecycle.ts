type RecorderCleanupTarget = {
	stop: () => Promise<void>;
};

export const stopRecorderOnUnmount = async (
	recorder: RecorderCleanupTarget,
): Promise<void> => {
	try {
		await recorder.stop();
	} catch {
		// Expo may release its native shared object before React runs this cleanup.
	}
};
