export type CloudCommandCrashRecovery =
	| "transactional-receipt"
	| "durable-workflow"
	| "generation-fenced";

export type CloudCommandEligibility = Readonly<{
	kind: string;
	schemaVersion: 1;
	maxPlaintextBytes: number;
	lane: "session";
	dependencies: "none" | "encrypted-attachments";
	destructionFence: true;
	recovery: CloudCommandCrashRecovery;
}>;

const command = (
	kind: string,
	recovery: CloudCommandCrashRecovery,
	dependencies: CloudCommandEligibility["dependencies"] = "none",
): CloudCommandEligibility => ({
	kind,
	schemaVersion: 1,
	maxPlaintextBytes: 128 * 1024,
	lane: "session",
	dependencies,
	destructionFence: true,
	recovery,
});

/**
 * The only source of truth for commands allowed into a cloud mailbox. A kind
 * absent here remains live-only even when an old call site labels it retry-safe.
 */
export const CLOUD_COMMAND_ELIGIBILITY = new Map(
	[
		command("session.rename", "transactional-receipt"),
		command("session.setRuntimeMode", "transactional-receipt"),
		command(
			"messages.queue.add",
			"transactional-receipt",
			"encrypted-attachments",
		),
		command(
			"messages.queue.update",
			"transactional-receipt",
			"encrypted-attachments",
		),
		command("messages.queue.delete", "transactional-receipt"),
		command("messages.queue.reorder", "transactional-receipt"),
		command("messages.send", "durable-workflow", "encrypted-attachments"),
		command("messages.queue.runNext", "durable-workflow"),
		command("messages.queue.flush", "durable-workflow"),
		command("messages.queue.resume", "durable-workflow"),
		command("session.create", "durable-workflow"),
		command("session.setModel", "durable-workflow"),
		command("session.setProvider", "durable-workflow"),
		command("messages.interrupt", "generation-fenced"),
		command("session.setPermissionMode", "generation-fenced"),
		command("session.answerQuestion", "generation-fenced"),
		command("session.plan.respond", "generation-fenced"),
		command("session.resume", "generation-fenced"),
		command("session.goal.set", "generation-fenced"),
		command("session.goal.clear", "generation-fenced"),
	].map((entry) => [entry.kind, entry] as const),
);

export const cloudCommandEligibility = (
	kind: string,
): CloudCommandEligibility | undefined => CLOUD_COMMAND_ELIGIBILITY.get(kind);
