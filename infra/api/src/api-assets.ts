import type { ApiAsset } from "@zuse/contracts";
import {
	base64UrlToBytes,
	bytesToBase64Url,
	sha256Base64Url,
} from "@zuse/utils/cloud-transcript-crypto";
import { Effect, Schema } from "effect";
import { openApiString, sealApiString } from "./api-sealing.ts";
import { ApiConfiguration } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { badRequest, conflict, serviceUnavailable } from "./errors.ts";

export const API_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const API_MESSAGE_MAX_ASSETS = 8;

const SUPPORTED_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"application/json",
	"application/zip",
]);

const StoredAsset = Schema.Struct({
	version: Schema.Literal(1),
	assetId: Schema.String,
	accountId: Schema.String,
	workspaceId: Schema.String,
	mimeType: Schema.String,
	originalName: Schema.String,
	sizeBytes: Schema.Number,
	sha256: Schema.String,
	bytes: Schema.String,
	createdAt: Schema.Number,
});

type StoredAsset = typeof StoredAsset.Type;

const assetContext = (
	accountId: string,
	workspaceId: string,
	assetId: string,
): string => `asset\n${accountId}\n${workspaceId}\n${assetId}`;

const assetObjectKey = (workspaceId: string, assetId: string): string =>
	`workspaces/${encodeURIComponent(workspaceId)}/api-assets/${encodeURIComponent(assetId)}.json`;

const safeOriginalName = (value: string): string => {
	const candidate = value
		.trim()
		.replaceAll("\\", "/")
		.split("/")
		.at(-1)
		?.trim();
	const name = [...(candidate ?? "")]
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code >= 32 && code !== 127;
		})
		.join("")
		.trim();
	return name.length === 0 ? "attachment" : name.slice(0, 255);
};

const publicAsset = (asset: StoredAsset): ApiAsset => ({
	assetId: asset.assetId,
	mimeType: asset.mimeType,
	originalName: asset.originalName,
	sizeBytes: asset.sizeBytes,
});

const objects = Effect.gen(function* () {
	const store = (yield* ApiConfiguration).cloudTranscriptObjects;
	if (store === undefined)
		return yield* Effect.fail(
			serviceUnavailable("api_asset_store_unavailable"),
		);
	return store;
});

const decodeStored = Effect.fn("decodeApiAsset")(function* (
	accountId: string,
	workspaceId: string,
	assetId: string,
	sealed: string,
) {
	const plaintext = yield* openApiString(
		assetContext(accountId, workspaceId, assetId),
		sealed,
	);
	return yield* Effect.try({
		try: () => Schema.decodeUnknownSync(StoredAsset)(JSON.parse(plaintext)),
		catch: () => serviceUnavailable("api_asset_corrupt"),
	});
});

export const getApiAsset = Effect.fn("getApiAsset")(function* (
	accountId: string,
	workspaceId: string,
	assetId: string,
) {
	if (!/^asset_[A-Za-z0-9_-]{16,80}$/u.test(assetId))
		return yield* Effect.fail(badRequest("invalid_asset_id"));
	const store = yield* objects;
	const sealed = yield* Effect.tryPromise({
		try: () => store.get(assetObjectKey(workspaceId, assetId)),
		catch: () => serviceUnavailable("api_asset_store_read_failed"),
	});
	if (sealed === null) return null;
	const asset = yield* decodeStored(accountId, workspaceId, assetId, sealed);
	if (
		asset.accountId !== accountId ||
		asset.workspaceId !== workspaceId ||
		asset.assetId !== assetId
	)
		return yield* Effect.fail(serviceUnavailable("api_asset_owner_mismatch"));
	return { asset: publicAsset(asset), bytes: base64UrlToBytes(asset.bytes) };
});

export const putApiAsset = Effect.fn("putApiAsset")(function* (input: {
	readonly accountId: string;
	readonly workspaceId: string;
	readonly mimeType: string;
	readonly originalName: string;
	readonly bytes: Uint8Array;
	readonly idempotencyKey?: string;
	readonly nowMs: number;
}) {
	const mimeType = input.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
	if (!SUPPORTED_MIME_TYPES.has(mimeType))
		return yield* Effect.fail(badRequest("unsupported_asset_type"));
	if (
		input.bytes.byteLength === 0 ||
		input.bytes.byteLength > API_ASSET_MAX_BYTES
	)
		return yield* Effect.fail(badRequest("invalid_asset_size"));
	const originalName = safeOriginalName(input.originalName);
	const selectedKey = input.idempotencyKey?.trim();
	if (
		selectedKey !== undefined &&
		(selectedKey.length === 0 || selectedKey.length > 200)
	)
		return yield* Effect.fail(badRequest("invalid_idempotency_key"));
	const assetId =
		selectedKey === undefined
			? yield* randomToken("asset", 18)
			: `asset_${(
					yield* sha256Hex(
						`api-asset-v1\n${input.accountId}\n${input.workspaceId}\n${selectedKey}`,
					)
				).slice(0, 40)}`;
	const sha256 = yield* Effect.promise(() => sha256Base64Url(input.bytes));
	const existing = yield* getApiAsset(
		input.accountId,
		input.workspaceId,
		assetId,
	);
	if (existing !== null) {
		if (
			existing.asset.mimeType !== mimeType ||
			existing.asset.originalName !== originalName ||
			existing.asset.sizeBytes !== input.bytes.byteLength ||
			(yield* Effect.promise(() => sha256Base64Url(existing.bytes))) !== sha256
		)
			return yield* Effect.fail(
				conflict("idempotency_key_reused_with_different_asset"),
			);
		return existing.asset;
	}
	const stored: StoredAsset = {
		version: 1,
		assetId,
		accountId: input.accountId,
		workspaceId: input.workspaceId,
		mimeType,
		originalName,
		sizeBytes: input.bytes.byteLength,
		sha256,
		bytes: bytesToBase64Url(input.bytes),
		createdAt: input.nowMs,
	};
	const sealed = yield* sealApiString(
		assetContext(input.accountId, input.workspaceId, assetId),
		JSON.stringify(stored),
	);
	const store = yield* objects;
	const write = yield* Effect.tryPromise({
		try: () => store.put(assetObjectKey(input.workspaceId, assetId), sealed),
		catch: () => serviceUnavailable("api_asset_store_write_failed"),
	});
	if (write === "exists") {
		const raced = yield* getApiAsset(
			input.accountId,
			input.workspaceId,
			assetId,
		);
		if (
			raced === null ||
			raced.asset.mimeType !== mimeType ||
			raced.asset.originalName !== originalName ||
			raced.asset.sizeBytes !== input.bytes.byteLength ||
			(yield* Effect.promise(() => sha256Base64Url(raced.bytes))) !== sha256
		)
			return yield* Effect.fail(
				conflict("idempotency_key_reused_with_different_asset"),
			);
	}
	return publicAsset(stored);
});
