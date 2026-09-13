import type { UpdateChannel } from "@zuse/contracts";
import { readPreference, writePreference } from "./atomic-preference.ts";

export function isUpdateChannel(value: unknown): value is UpdateChannel {
	return value === "stable" || value === "preview";
}

export const readUpdatePreference = (directory: string) =>
	readPreference(
		directory,
		"update-channel.json",
		(value): { channel: UpdateChannel; downgradeFrom?: string } => {
			if (
				typeof value !== "object" ||
				value === null ||
				!("channel" in value) ||
				!isUpdateChannel(value.channel)
			)
				return { channel: "stable" };
			return {
				channel: value.channel,
				downgradeFrom:
					"downgradeFrom" in value && typeof value.downgradeFrom === "string"
						? value.downgradeFrom
						: undefined,
			};
		},
	);
export const readUpdateChannel = async (directory: string) =>
	(await readUpdatePreference(directory)).channel;
export const writeUpdateChannel = (
	directory: string,
	channel: UpdateChannel,
	downgradeFrom?: string,
) =>
	writePreference(directory, "update-channel.json", { channel, downgradeFrom });

/** Serializes feed changes with checks/downloads; a requested switch immediately revokes install eligibility. */
export class UpdateChannelCoordinator {
	private tail = Promise.resolve();
	private switches = 0;
	private cancel: (() => void) | undefined;
	channel: UpdateChannel = "stable";

	constructor(
		private readonly persist: (channel: UpdateChannel) => Promise<void>,
		private readonly invalidate: () => void,
	) {}

	get switching(): boolean {
		return this.switches > 0;
	}

	run(operation: () => Promise<void>, cancel: () => void): Promise<void> {
		return this.enqueue(async () => {
			if (this.switching) return;
			this.cancel = cancel;
			try {
				await operation();
			} finally {
				this.cancel = undefined;
			}
		});
	}

	setChannel(channel: unknown): Promise<void> {
		if (!isUpdateChannel(channel))
			return Promise.reject(new Error("Invalid update channel"));
		this.switches++;
		this.invalidate();
		this.cancel?.();
		return this.enqueue(async () => {
			try {
				await this.persist(channel);
				this.channel = channel;
			} finally {
				this.switches--;
			}
		});
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => undefined);
		return result;
	}
}
