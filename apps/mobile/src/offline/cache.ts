import { Message, MessageEnvelope } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import * as FileSystem from "expo-file-system/legacy";

import { CacheCorrupt } from "../rpc/errors";
import { slugConnectionKey } from "./cache-utils";

const ROOT = `${FileSystem.documentDirectory ?? ""}zuse-cache`;

export const clearOfflineCache = () => deletePath(ROOT);

const downloadedPaths = (connectionRoot: string) => [
	`${connectionRoot}/sessions.json`,
	`${connectionRoot}/messages`,
];

const pathSize = async (path: string): Promise<number> => {
	const info = await FileSystem.getInfoAsync(path);
	if (!info.exists) return 0;
	if (!info.isDirectory) return info.size;
	const children = await FileSystem.readDirectoryAsync(path);
	return (
		await Promise.all(children.map((child) => pathSize(`${path}/${child}`)))
	).reduce((total, size) => total + size, 0);
};

const connectionRoots = async (): Promise<string[]> => {
	const info = await FileSystem.getInfoAsync(ROOT);
	if (!info.exists || !info.isDirectory) return [];
	return (await FileSystem.readDirectoryAsync(ROOT)).map(
		(name) => `${ROOT}/${name}`,
	);
};

export const downloadedCacheSize = async (): Promise<number> => {
	const roots = await connectionRoots();
	const sizes = await Promise.all(
		roots.flatMap((root) => downloadedPaths(root)).map(pathSize),
	);
	return sizes.reduce((total, size) => total + size, 0);
};

export const clearDownloadedCache = () =>
	Effect.tryPromise({
		try: async () => {
			const roots = await connectionRoots();
			await Promise.all(
				roots
					.flatMap((root) => downloadedPaths(root))
					.map((path) => FileSystem.deleteAsync(path, { idempotent: true })),
			);
		},
		catch: (cause) => cause,
	});

export type SessionsSnapshot = {
	projects: readonly unknown[];
	chats: readonly unknown[];
	sessions: readonly unknown[];
	savedAt: number;
};

export type MessagesSnapshot = {
	highestSequence: number;
	messages: readonly Message[];
};

/** One message the user sent while offline, awaiting flush to the server. */
export type QueuedMessage = {
	clientId: string;
	text: string;
	asGoal?: boolean;
	createdAt: number;
};

export type OutboxSnapshot = {
	items: readonly QueuedMessage[];
};

const ensureDir = (path: string) =>
	Effect.tryPromise({
		try: async () => {
			await FileSystem.makeDirectoryAsync(path, { intermediates: true });
		},
		catch: (cause) => cause,
	});

const readJson = <A>(
	path: string,
	decode: (u: unknown) => A,
): Effect.Effect<A | null, CacheCorrupt> =>
	Effect.tryPromise({
		try: async () => {
			const info = await FileSystem.getInfoAsync(path);
			if (!info.exists) return null;
			const raw = await FileSystem.readAsStringAsync(path);
			return decode(JSON.parse(raw));
		},
		catch: (cause) =>
			new CacheCorrupt({
				path,
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	});

const writeJson = (path: string, value: unknown) =>
	Effect.tryPromise({
		try: () => FileSystem.writeAsStringAsync(path, JSON.stringify(value)),
		catch: (cause) => cause,
	});

export const sessionsPath = (connKey: string) =>
	`${ROOT}/${slugConnectionKey(connKey)}/sessions.json`;

export const messagesPath = (connKey: string, sessionId: string) =>
	`${ROOT}/${slugConnectionKey(connKey)}/messages/${slugConnectionKey(sessionId)}.json`;

export const outboxPath = (connKey: string, sessionId: string) =>
	`${ROOT}/${slugConnectionKey(connKey)}/outbox/${slugConnectionKey(sessionId)}.json`;

export const readSessionsSnapshot = (connKey: string) =>
	readJson(sessionsPath(connKey), (u) => u as SessionsSnapshot).pipe(
		Effect.catchTag("CacheCorrupt", (error) =>
			Effect.andThen(deletePath(error.path), Effect.succeed(null)),
		),
	);

export const writeSessionsSnapshot = (
	connKey: string,
	snapshot: SessionsSnapshot,
) =>
	ensureDir(`${ROOT}/${slugConnectionKey(connKey)}`).pipe(
		Effect.andThen(writeJson(sessionsPath(connKey), snapshot)),
	);

const EncodedMessagesSnapshot = Schema.Struct({
	highestSequence: Schema.Number,
	messages: Schema.Array(Message),
});

export const readMessagesSnapshot = (connKey: string, sessionId: string) =>
	readJson(messagesPath(connKey, sessionId), (u) =>
		Schema.decodeUnknownSync(EncodedMessagesSnapshot)(u),
	).pipe(
		Effect.catchTag("CacheCorrupt", (error) =>
			Effect.andThen(deletePath(error.path), Effect.succeed(null)),
		),
	);

export const writeMessagesSnapshot = (
	connKey: string,
	sessionId: string,
	snapshot: MessagesSnapshot,
) => {
	const path = messagesPath(connKey, sessionId);
	const dir = path.slice(0, path.lastIndexOf("/"));
	return ensureDir(dir).pipe(
		Effect.andThen(
			writeJson(path, Schema.encodeSync(EncodedMessagesSnapshot)(snapshot)),
		),
	);
};

export const readOutboxSnapshot = (connKey: string, sessionId: string) =>
	readJson(outboxPath(connKey, sessionId), decodeOutboxSnapshot).pipe(
		Effect.catchTag("CacheCorrupt", (error) =>
			Effect.andThen(deletePath(error.path), Effect.succeed(null)),
		),
	);

const decodeOutboxSnapshot = (value: unknown): OutboxSnapshot => {
	if (typeof value !== "object" || value === null || !("items" in value))
		return { items: [] };
	const raw = Reflect.get(value, "items");
	if (!Array.isArray(raw)) return { items: [] };
	return {
		items: raw.flatMap((item) => {
			if (typeof item !== "object" || item === null) return [];
			const clientId = Reflect.get(item, "clientId");
			const text = Reflect.get(item, "text");
			const createdAt = Reflect.get(item, "createdAt");
			if (
				typeof clientId !== "string" ||
				typeof text !== "string" ||
				typeof createdAt !== "number"
			)
				return [];
			const asGoal = Reflect.get(item, "asGoal");
			return [
				{
					clientId,
					text,
					createdAt,
					...(typeof asGoal === "boolean" ? { asGoal } : {}),
				},
			];
		}),
	};
};

export const writeOutboxSnapshot = (
	connKey: string,
	sessionId: string,
	snapshot: OutboxSnapshot,
) => {
	const path = outboxPath(connKey, sessionId);
	const dir = path.slice(0, path.lastIndexOf("/"));
	return ensureDir(dir).pipe(Effect.andThen(writeJson(path, snapshot)));
};

export const decodeEnvelopeFixture = (value: unknown): MessageEnvelope =>
	Schema.decodeUnknownSync(MessageEnvelope)(value);

export const deletePath = (path: string) =>
	Effect.tryPromise({
		try: async () => {
			await FileSystem.deleteAsync(path, { idempotent: true });
		},
		catch: (cause) => cause,
	});
