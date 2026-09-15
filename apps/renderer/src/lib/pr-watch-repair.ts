import { ComposerInput, MessageId } from "@zuse/contracts";
import type { PrWatch } from "../store/pr-watch.ts";

export async function runPrWatchRepair(options: {
	watch: PrWatch;
	key: string;
	current: () => PrWatch | undefined;
	save: (watch: PrWatch) => void;
	prepare: () => Promise<ComposerInput>;
	canSend: () => boolean;
	send: (input: ComposerInput, messageId: MessageId) => Promise<boolean>;
}): Promise<void> {
	const { watch, key, current, save } = options;
	const isCurrent = () => {
		const latest = current();
		return (
			latest?.enabled === true &&
			latest.generation === watch.generation &&
			latest.sessionId === watch.sessionId
		);
	};
	let pending = watch.pending;
	if (pending === null || pending.key !== key) {
		const input = await options.prepare();
		pending = {
			key,
			messageId: MessageId.make(crypto.randomUUID()),
			input: new ComposerInput({
				...input,
				text: `${input.text}\nAfter verification, commit and push the repair to this PR branch. The CI watcher will check the next run. Do not merge the PR.`,
			}),
		};
		if (!isCurrent()) return;
		save({ ...watch, pending });
	}
	if (!isCurrent() || !options.canSend()) return;
	// Save before dispatch, reuse after restart, and only acknowledge acceptance.
	if (!(await options.send(pending.input, pending.messageId)))
		throw new Error(
			"Repair delivery could not be confirmed. Check the chat before resuming.",
		);
	const latest = current();
	if (latest && latest.generation === watch.generation)
		save({ ...latest, pending: null, handled: [...latest.handled, key] });
}
