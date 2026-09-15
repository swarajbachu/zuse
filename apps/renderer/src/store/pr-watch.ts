import {
	ComposerInput,
	EnvironmentId,
	FolderId,
	MessageId,
	SessionId,
	WorktreeId,
} from "@zuse/contracts";
import { Schema } from "effect";
import { createAtomStore as create } from "../state/atom-store.ts";

const WatchSchema = Schema.Struct({
	id: Schema.String,
	generation: Schema.optional(Schema.String),
	ref: Schema.Struct({
		environmentId: EnvironmentId,
		folderId: FolderId,
		worktreeId: Schema.NullOr(WorktreeId),
		rootPath: Schema.String,
	}),
	sessionId: SessionId,
	url: Schema.String,
	branch: Schema.String,
	enabled: Schema.Boolean,
	handled: Schema.Array(Schema.String),
	maxRepairs: Schema.Number,
	error: Schema.NullOr(Schema.String),
	pending: Schema.NullOr(
		Schema.Struct({
			key: Schema.String,
			messageId: MessageId,
			input: ComposerInput,
		}),
	),
});
export type PrWatch = typeof WatchSchema.Type;
const STORAGE_KEY = "zuse.pr-watches.v1";
function read(): readonly PrWatch[] {
	try {
		if (typeof window === "undefined") return [];
		return Schema.decodeUnknownSync(Schema.Array(WatchSchema))(
			JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"),
		);
	} catch {
		return [];
	}
}
type State = {
	watches: readonly PrWatch[];
	save: (watch: PrWatch) => void;
	remove: (id: string) => void;
};
export const usePrWatchStore = create<State>((set, get) => {
	const persist = (watches: readonly PrWatch[]) => {
		// Enabling unattended work requires durable deduplication. Surface storage
		// failures instead of silently losing the record and retrying a repair.
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(watches));
		} catch (cause) {
			set({
				watches: watches.map((watch) => ({
					...watch,
					enabled: false,
					error: "Watcher storage is unavailable.",
				})),
			});
			throw cause;
		}
		set({ watches });
	};
	return {
		watches: read(),
		save: (watch) =>
			persist([...get().watches.filter((item) => item.id !== watch.id), watch]),
		remove: (id) => persist(get().watches.filter((watch) => watch.id !== id)),
	};
});
