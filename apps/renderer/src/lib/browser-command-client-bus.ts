import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import {
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import {
	type BrowserCommandRequest,
	BrowserCommandResult,
	CommandId,
	EnvironmentId,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useEffect, useMemo } from "react";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useUiStore } from "../store/ui.ts";
import {
	browserChatIdForSession,
	waitForBrowserController,
} from "./browser-controller-registry.ts";
import { environmentShellData } from "./environment-entities.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";

type BrowserCommandBridgeData = Readonly<{
	attached: boolean;
	processed: number;
}>;

const keyFor = (environmentId: EnvironmentId) =>
	makeResourceKey<BrowserCommandBridgeData>("environment-browser-commands", {
		environmentId,
	});

const environmentFrom = (key: ResourceKey<unknown>): EnvironmentId | null =>
	key.kind === "environment-browser-commands" && !("sessionId" in key.ref)
		? key.ref.environmentId
		: null;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const respondToBrowserCommand = async (
	environmentId: EnvironmentId,
	result: BrowserCommandResult,
): Promise<void> => {
	const bus = getRendererClientBus();
	await bus.dispatch({
		kind: "browser.respond",
		commandId: CommandId.make(`browser-response:${result.id}`),
		environmentId,
		resource: keyFor(environmentId),
		payload: { result },
		retry: "never",
		createdAt: Date.now(),
	});
};

const respondUnavailable = async (
	environmentId: EnvironmentId,
	request: BrowserCommandRequest,
	error: string,
): Promise<void> => {
	try {
		await respondToBrowserCommand(
			environmentId,
			BrowserCommandResult.make({ id: request.id, ok: false, error }),
		);
	} catch {
		// The server applies its bounded command timeout when a response cannot
		// reach the request's original runtime generation.
	}
};

const makeDriver = (): ResourceDriver<
	MemoizeClient,
	BrowserCommandBridgeData
> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const environmentId = environmentFrom(context.key);
			if (environmentId === null) return;
			active = true;
			const epoch = `browser-commands:${context.generation}:${crypto.randomUUID()}`;
			let version = 1;
			let processed = context.data?.processed ?? 0;
			context.emit({
				data: { attached: true, processed },
				cursor: { epoch, version },
				resetEpoch: true,
				sync: "live",
			});

			const handle = async (request: BrowserCommandRequest): Promise<void> => {
				if (!active || !context.isCurrent()) return;
				const chatId = browserChatIdForSession(
					environmentShellData(environmentId)?.sessionsByProject ?? {},
					request.sessionId,
				);
				if (chatId === null) {
					await respondUnavailable(
						environmentId,
						request,
						"The browser command belongs to a session that is not available in this renderer.",
					);
					return;
				}
				const ref = { environmentId, chatId };
				useUiStore.getState().revealPanelForChat(ref, "browser");
				const controller = await waitForBrowserController(ref);
				if (controller === null) {
					await respondUnavailable(
						environmentId,
						request,
						"The browser for this chat could not be started.",
					);
					return;
				}
				await controller(request);
				if (!active || !context.isCurrent()) return;
				processed += 1;
				version += 1;
				context.emit({
					data: { attached: true, processed },
					cursor: { epoch, version },
					sync: "live",
				});
			};

			const program = Stream.runForEach(
				context.client["browser.commands"]({}),
				(request) => Effect.promise(() => handle(request)),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Browser command stream ended unexpectedly")),
				),
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (!active || Cause.hasInterruptsOnly(cause)) return;
						context.emit({ sync: "failed" });
						getRendererClientBus().reportConnectionFault(
							environmentId,
							{ phase: "failed", message: messageOf(Cause.squash(cause)) },
							context.generation,
						);
					}),
				),
			);
			fiber = Effect.runFork(program);
		},
		stop: () => {
			active = false;
			const running = fiber;
			fiber = null;
			if (running !== null) void Effect.runPromise(Fiber.interrupt(running));
		},
	};
};

registerRendererResourceDriver("environment-browser-commands", (key) =>
	environmentFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

/** Retain the sole environment-scoped browser command subscription. */
export const useBrowserCommandBridge = (): void => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore((state) => state.activeEnvironmentId),
	);
	const key = useMemo(() => keyFor(environmentId), [environmentId]);
	const bus = getRendererClientBus();
	useEffect(
		() => bus.retain(key, { activation: "connect" }).release,
		[bus, key],
	);
};
