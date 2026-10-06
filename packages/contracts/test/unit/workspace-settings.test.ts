import { Exit, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";
import {
	CloudSettingsGetRpc,
	CloudSettingsUpdateRpc,
} from "../../src/cloud-workspaces.ts";
import {
	WorkspaceSettings,
	WorkspaceSettingsUpdate,
} from "../../src/settings.ts";

const legacyValues = {
	defaultModelByProvider: { claude: "custom-model" },
	providerEnabled: { claude: false },
	modelEnabledByProvider: { claude: { "custom-model": false } },
	customModelIdsByProvider: { claude: ["custom-model"] },
};

describe("workspace settings across provider additions", () => {
	it("reads saved preferences without requiring newly introduced providers", () => {
		expect(
			Schema.decodeUnknownSync(WorkspaceSettings)({
				revision: 3,
				values: legacyValues,
			}),
		).toEqual({ revision: 3, values: legacyValues });
	});
	it("accepts the same sparse preferences on update", () => {
		expect(
			Schema.decodeUnknownSync(WorkspaceSettingsUpdate)({
				expectedRevision: 3,
				values: legacyValues,
			}),
		).toEqual({ expectedRevision: 3, values: legacyValues });
	});
	it("still rejects invalid provider preference values", () => {
		expect(() =>
			Schema.decodeUnknownSync(WorkspaceSettings)({
				revision: 3,
				values: { providerEnabled: { claude: "yes" } },
			}),
		).toThrow();
	});
});

for (const values of [
	legacyValues,
	{},
	{
		defaultModelByProvider: { "acp-custom": "custom-model" },
		providerEnabled: { "acp-custom": false },
		modelEnabledByProvider: { "acp-custom": { "custom-model": false } },
		customModelIdsByProvider: { "acp-custom": ["custom-model"] },
	},
]) {
	it("round-trips sparse preferences through the cloud settings RPC codecs", () => {
		const settings = { revision: 3, values };
		const exitCodec = Schema.toCodecJson(Rpc.exitSchema(CloudSettingsGetRpc));
		const exit = Exit.succeed(settings);
		const encodedExit = Schema.encodeSync(exitCodec)(exit);
		expect(Schema.decodeUnknownSync(exitCodec)(encodedExit)).toEqual(exit);
		const updateCodec = Schema.toCodecJson(
			CloudSettingsUpdateRpc.payloadSchema,
		);
		const update = { expectedRevision: 3, values };
		expect(
			Schema.decodeUnknownSync(updateCodec)(
				Schema.encodeSync(updateCodec)(update),
			),
		).toEqual(update);
	});
}
