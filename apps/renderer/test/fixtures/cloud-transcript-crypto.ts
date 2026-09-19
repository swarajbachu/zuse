import {
	bytesToBase64Url,
	decryptCloudTranscript,
	encryptCloudTranscript,
} from "@zuse/utils/cloud-transcript-crypto";

export async function run() {
	const encodedKey = bytesToBase64Url(
		crypto.getRandomValues(new Uint8Array(32)),
	);
	const additionalData = new TextEncoder().encode(
		"workspace/session/epoch/version",
	);
	const results = [];
	for (const length of [0, 16, 1_000_000]) {
		const plaintext = new Uint8Array(length);
		for (let offset = 0; offset < length; offset += 65536)
			crypto.getRandomValues(
				plaintext.subarray(offset, Math.min(length, offset + 65536)),
			);
		const start = performance.now();
		const ciphertext = await encryptCloudTranscript({
			encodedKey,
			additionalData,
			plaintext,
		});
		const decoded = await decryptCloudTranscript({
			encodedKey,
			additionalData,
			ciphertext,
		});
		if (
			decoded.length !== plaintext.length ||
			!decoded.every((byte, index) => byte === plaintext[index])
		)
			throw new Error("Transcript round trip changed its contents");
		let rejected = false;
		try {
			await decryptCloudTranscript({
				encodedKey,
				additionalData: new Uint8Array([0]),
				ciphertext,
			});
		} catch {
			rejected = true;
		}
		if (!rejected)
			throw new Error("Incorrect authenticated metadata was accepted");
		results.push({
			bytes: length,
			milliseconds: Math.round(performance.now() - start),
		});
	}
	return results;
}
