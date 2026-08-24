export type BufferedInbox<Frame> = Readonly<{
	attach: (deliver: (frame: Frame) => void) => void;
	dispose: () => void;
}>;

/**
 * Subscribes immediately, then preserves frames until the eventual consumer is
 * ready. Electron IPC is fire-and-forget, so installing the host listener only
 * after the Effect runtime launches can otherwise lose the renderer's first
 * handshake during a slow desktop startup.
 */
export const makeBufferedInbox = <Frame>(
	subscribe: (receive: (frame: Frame) => void) => () => void,
): BufferedInbox<Frame> => {
	const pending: Frame[] = [];
	let deliver: ((frame: Frame) => void) | null = null;
	let disposed = false;
	const unsubscribe = subscribe((frame) => {
		if (disposed) return;
		if (deliver === null) {
			pending.push(frame);
			return;
		}
		deliver(frame);
	});

	return {
		attach: (next) => {
			if (disposed) return;
			deliver = next;
			for (const frame of pending.splice(0)) next(frame);
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			deliver = null;
			pending.length = 0;
			unsubscribe();
		},
	};
};
