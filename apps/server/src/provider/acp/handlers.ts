import {
	type AcpAuthenticationEvent,
	AcpOperationError,
	MemoizeRpcs,
	PtyOwnerId,
} from "@zuse/contracts";
import { type Cause, Effect, Layer, Queue, Stream } from "effect";
import { PtyService } from "../../pty/services/pty-service.ts";
import { extractProviderLoginUrl } from "../services/login-service.ts";
import { AcpAgentService, acpOperation } from "./service.ts";

export const AcpHandlers = Layer.mergeAll(
	MemoizeRpcs.toLayerHandler(
		"provider.acp.duplicate",
		({ id, accountProvider }) =>
			acpOperation((service) => service.duplicate(id, accountProvider)).pipe(
				Effect.uninterruptible,
			),
	),
	MemoizeRpcs.toLayerHandler("provider.acp.list", () =>
		acpOperation((service) => service.list()),
	),
	MemoizeRpcs.toLayerHandler("provider.acp.catalog", () =>
		acpOperation((service) => service.catalog()),
	),
	MemoizeRpcs.toLayerHandler("provider.acp.save", (input) =>
		acpOperation((service) => service.save(input)).pipe(Effect.uninterruptible),
	),
	MemoizeRpcs.toLayerHandler("provider.acp.remove", ({ id }) =>
		acpOperation((service) => service.remove(id)).pipe(Effect.uninterruptible),
	),
	MemoizeRpcs.toLayerHandler("provider.acp.test", ({ id }) =>
		acpOperation((service) => service.test(id)),
	),
	MemoizeRpcs.toLayerHandler("provider.acp.install", ({ catalogId, id }) =>
		acpOperation((service) => service.install(catalogId, id)).pipe(
			Effect.uninterruptible,
		),
	),
	MemoizeRpcs.toLayerHandler("provider.acp.authenticate", ({ id, methodId }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				const service = yield* AcpAgentService;
				const definition = yield* acpOperation((service) => service.get(id));
				const method = definition.probe?.authMethods.find(
					(item) => item.id === methodId,
				);
				if (!method)
					return yield* new AcpOperationError({
						message:
							"Test the connection to discover authentication methods first.",
					});
				if (method.type === "terminal") {
					const pty = yield* PtyService;
					const launch = yield* acpOperation((service) => service.launch(id));
					const ownerId = PtyOwnerId.make(`acp-auth:${id}`);
					const terminal = yield* pty
						.open(
							service.directory,
							90,
							20,
							{
								cmd: launch.command,
								args: [...launch.args, ...(method.args ?? [])],
								env: { ...method.env, ...launch.env },
								unsetEnv: launch.unsetEnv,
							},
							{
								ownerId,
								label: `${definition.name} sign in`,
								scope: "environment",
							},
						)
						.pipe(
							Effect.mapError(
								(error) => new AcpOperationError({ message: String(error) }),
							),
						);
					return Stream.concat(
						Stream.make({
							_tag: "terminal" as const,
							...terminal,
							ownerId,
							cwd: service.directory,
						}),
						pty
							.subscribe(
								terminal.ptyId,
								undefined,
								terminal.processEpoch,
								ownerId,
							)
							.pipe(
								Stream.filter((event) => event._tag === "exit"),
								Stream.take(1),
								Stream.mapEffect((event) =>
									event.exitCode === 0
										? acpOperation((service) => service.test(id)).pipe(
												Effect.map((result) => ({
													_tag: "done" as const,
													ok: result.status === "ready",
													reason: result.message,
												})),
											)
										: Effect.succeed({
												_tag: "done" as const,
												ok: false,
												reason:
													"The sign-in process did not complete successfully. Try again or sign in directly on this host.",
											}),
								),
								Stream.mapError(
									(error) => new AcpOperationError({ message: String(error) }),
								),
							),
					).pipe(
						Stream.ensuring(
							pty.close(terminal.ptyId, ownerId).pipe(Effect.ignore),
						),
					);
				}
				const events = yield* Queue.make<
					typeof AcpAuthenticationEvent.Type,
					Cause.Done
				>();
				let lastUrl: string | undefined;
				yield* acpOperation((service, signal) =>
					service.test(
						id,
						methodId,
						(line) => {
							const url = extractProviderLoginUrl(line);
							if (!url || url === lastUrl) return;
							lastUrl = url;
							Queue.offerUnsafe(events, { _tag: "url", url });
						},
						signal,
					),
				).pipe(
					Effect.tap((result) =>
						Effect.sync(() =>
							Queue.offerUnsafe(events, {
								_tag: "done",
								ok: result.status === "ready",
								reason: result.message,
							}),
						),
					),
					Effect.catch((error) =>
						Effect.sync(() =>
							Queue.offerUnsafe(events, {
								_tag: "done",
								ok: false,
								reason: error.message,
							}),
						),
					),
					Effect.ensuring(Queue.end(events)),
					Effect.forkScoped,
				);
				return Stream.fromQueue(events);
			}),
		),
	),
);
