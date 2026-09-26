import { Alert } from "react-native";

export type AiSharingRequest = {
	recipient: string;
	destination: "computer" | "cloud" | "voice";
	model?: string;
	scope?: string;
};

const accepted = new Set<string>();
const pending = new Map<string, Promise<boolean>>();
let generation = 0;

/** Choices last for this app session and are scoped to the selected recipient/model. */
export const resetAiSharingConsent = (): void => {
	generation += 1;
	accepted.clear();
	pending.clear();
};

export const requestAiSharingConsent = (
	request: AiSharingRequest,
): Promise<boolean> => {
	const key = JSON.stringify(request);
	if (accepted.has(key)) return Promise.resolve(true);
	const existing = pending.get(key);
	if (existing) return existing;
	const epoch = generation;
	const recipient = request.model
		? `${request.recipient} (${request.model})`
		: request.recipient;
	const message =
		request.destination === "voice"
			? "Your recording will be sent to OpenAI for transcription using the account connected to your Zuse environment. Audio may travel through that environment or directly from this device. The transcript stays in your draft until you send it."
			: `Your messages, selected images and files, and relevant workspace context will be sent ${request.destination === "cloud" ? "through your Zuse cloud workspace" : "through your connected computer"} to ${recipient} and the model services configured for that agent. Connected tools may send data to services you authorize. This can include personal or confidential information.`;
	const result = new Promise<boolean>((resolve) => {
		const finish = (allow: boolean) => {
			const valid = allow && epoch === generation;
			if (valid) accepted.add(key);
			resolve(valid);
		};
		Alert.alert(
			request.destination === "voice"
				? "Share audio with OpenAI?"
				: "Share data with your AI provider?",
			`${message}\n\nTheir privacy policies apply. You can reset this choice in Settings → Privacy.`,
			[
				{ text: "Cancel", style: "cancel", onPress: () => finish(false) },
				{ text: "Agree and continue", onPress: () => finish(true) },
			],
			{ cancelable: true, onDismiss: () => finish(false) },
		);
	}).finally(() => {
		if (pending.get(key) === result) pending.delete(key);
	});
	pending.set(key, result);
	return result;
};
