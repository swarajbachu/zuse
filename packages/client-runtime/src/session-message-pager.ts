import type {
	Message,
	SessionStreamCursor,
	SessionTimelineProjection,
} from "@zuse/contracts";
import type { ClientBus } from "./client-bus.ts";
import {
	makeResourceKey,
	resourceKeyId,
	type SessionRef,
} from "./resource-ref.ts";
import {
	prependSessionTimelineMessages,
	restoreSessionTimelineState,
} from "./session-timeline.ts";

export type OlderSessionMessagesResult = Readonly<{
	applied: boolean;
	loaded: number;
	hasMore: boolean;
}>;
type Page = Readonly<{
	messages: readonly Message[];
	olderMessageSequence: number | null;
}>;

/** One bounded page, fenced by both the live stream and the pagination head. */
export const makeSessionMessagePager = <Client>(options: {
	getBus: () => ClientBus<Client>;
	allowLiveAdvance?: (ref: SessionRef) => boolean;
	readPage: (
		ref: SessionRef,
		client: Client | null,
		cursor: SessionStreamCursor | null,
		beforeSequence: number,
		signal?: AbortSignal,
	) => Promise<Page | null | undefined>;
}) => {
	const flights = new Map<string, Promise<OlderSessionMessagesResult>>();
	const load = (
		ref: SessionRef,
		signal?: AbortSignal,
	): Promise<OlderSessionMessagesResult> => {
		const key = makeResourceKey<SessionTimelineProjection>(
			"session-timeline",
			ref,
		);
		const id = resourceKeyId(key);
		const existing = flights.get(id);
		if (existing !== undefined) return existing;
		const bus = options.getBus();
		const initial = bus.snapshot(key);
		const beforeSequence = initial.data?.olderMessageSequence ?? null;
		if (initial.data === null || beforeSequence === null)
			return Promise.resolve({
				applied: false,
				loaded: 0,
				hasMore: beforeSequence !== null,
			});
		const request = (async () => {
			const page = await options.readPage(
				ref,
				bus.client(ref.environmentId),
				initial.cursor,
				beforeSequence,
				signal,
			);
			if (signal?.aborted || page == null || bus !== options.getBus())
				return { applied: false, loaded: 0, hasMore: true };
			if (
				page.olderMessageSequence !== null &&
				page.olderMessageSequence >= beforeSequence
			)
				throw new Error("Transcript pagination did not advance");
			const latest = bus.snapshot(key);
			const cursor =
				options.allowLiveAdvance?.(ref) === true &&
				latest.generation === initial.generation &&
				latest.cursor?.epoch === initial.cursor?.epoch &&
				(latest.cursor?.version ?? 0) >= (initial.cursor?.version ?? 0)
					? latest.cursor
					: initial.cursor;
			let loaded = 0;
			const applied = bus.update(key, {
				expectedGeneration: initial.generation,
				expectedCursor: cursor,
				persist:
					options.allowLiveAdvance?.(ref) === true ||
					page.olderMessageSequence === null,
				update: (projection) => {
					if ((projection.olderMessageSequence ?? null) !== beforeSequence)
						return undefined;
					const merged = prependSessionTimelineMessages(
						restoreSessionTimelineState(projection, initial.cursor),
						page.messages,
						page.olderMessageSequence,
					);
					loaded = Math.max(
						0,
						(merged.projection?.messages.length ?? 0) -
							projection.messages.length,
					);
					return merged.projection ?? undefined;
				},
			});
			return {
				applied,
				loaded: applied ? loaded : 0,
				hasMore: applied ? page.olderMessageSequence !== null : true,
			};
		})();
		flights.set(id, request);
		const clear = () => {
			if (flights.get(id) === request) flights.delete(id);
		};
		void request.then(clear, clear);
		return request;
	};
	return { load, clear: () => flights.clear() };
};
