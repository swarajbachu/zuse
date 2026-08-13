import type { ResourceDriver } from "@zuse/client-runtime/client-bus";
import {
	makeResourceKey,
	type ResourceKey,
} from "@zuse/client-runtime/resource-ref";
import {
	type Command,
	CommandId,
	EnvironmentId,
	type KeybindingRule,
	type KeybindingShortcut,
	type KeybindingsFile,
	type KeybindingWhenNode,
	keyToElectronAccelerator,
	MAX_KEYBINDING_RULES,
	parseKey,
	parseWhen,
} from "@zuse/contracts";
import { Cause, Effect, Fiber, Stream } from "effect";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { mergeWithDefaults } from "./default-keybindings.ts";
import type { MemoizeClient } from "./rpc-client.ts";
import {
	getRendererClientBus,
	registerRendererResourceDriver,
} from "./session-timeline-client-bus.ts";

export interface ResolvedRule {
	readonly rule: KeybindingRule;
	readonly shortcut: KeybindingShortcut;
	readonly whenAst: KeybindingWhenNode | null;
	readonly isDefault: boolean;
}

export type EnvironmentKeybindingsData = Readonly<{
	resolvedRules: ReadonlyArray<ResolvedRule>;
	userRules: ReadonlyArray<KeybindingRule>;
}>;

export type KeybindingsState = EnvironmentKeybindingsData &
	Readonly<{
		loaded: boolean;
		error: string | null;
		setUserRules: (rules: ReadonlyArray<KeybindingRule>) => Promise<void>;
		resetAll: () => Promise<void>;
		resetCommand: (command: Command) => Promise<void>;
		addRule: (rule: KeybindingRule) => Promise<void>;
		replaceUserRuleAt: (index: number, rule: KeybindingRule) => Promise<void>;
		removeUserRuleAt: (index: number) => Promise<void>;
	}>;

const resolveRules = (
	userRules: ReadonlyArray<KeybindingRule>,
): EnvironmentKeybindingsData => {
	const resolvedRules: ResolvedRule[] = [];
	for (const rule of mergeWithDefaults(userRules)) {
		const shortcut = parseKey(rule.key);
		if (shortcut === null) continue;
		let whenAst: KeybindingWhenNode | null = null;
		if (rule.when !== undefined && rule.when.length > 0) {
			const parsed = parseWhen(rule.when);
			if (parsed !== null && "type" in parsed) whenAst = parsed;
		}
		resolvedRules.push({
			rule,
			shortcut,
			whenAst,
			isDefault: !userRules.includes(rule),
		});
	}
	return { resolvedRules, userRules };
};

const FALLBACK = resolveRules([]);

const keyFor = (environmentId: EnvironmentId) =>
	makeResourceKey<EnvironmentKeybindingsData>("environment-keybindings", {
		environmentId,
	});

const environmentFrom = (key: ResourceKey<unknown>): EnvironmentId | null =>
	key.kind === "environment-keybindings" && !("sessionId" in key.ref)
		? key.ref.environmentId
		: null;

const menuAccelerators = (
	resolved: ReadonlyArray<ResolvedRule>,
): Readonly<Record<string, string | null>> => {
	const commands: ReadonlyArray<Command> = [
		"new-chat",
		"open-project",
		"settings",
		"close-tab",
		"toggle-left-sidebar",
		"toggle-right-sidebar",
		"toggle-terminal",
		"focus-composer",
	];
	const result: Record<string, string | null> = {};
	for (const command of commands) {
		let accelerator: string | null = null;
		for (let index = resolved.length - 1; index >= 0; index--) {
			const candidate = resolved[index];
			if (
				candidate === undefined ||
				candidate.rule.command !== command ||
				(candidate.rule.when?.length ?? 0) > 0
			) {
				continue;
			}
			accelerator = keyToElectronAccelerator(candidate.rule.key);
			break;
		}
		result[command] = accelerator;
	}
	return result;
};

let lastAccelerators = "";
const publishMenuAccelerators = (rules: ReadonlyArray<ResolvedRule>): void => {
	const accelerators = menuAccelerators(rules);
	const serialized = JSON.stringify(accelerators);
	if (serialized === lastAccelerators) return;
	lastAccelerators = serialized;
	window.zuse?.menu?.setAccelerators?.(accelerators);
};

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const makeDriver = (): ResourceDriver<
	MemoizeClient,
	EnvironmentKeybindingsData
> => {
	let fiber: Fiber.Fiber<unknown, unknown> | null = null;
	let active = false;
	return {
		start: (context) => {
			const environmentId = environmentFrom(context.key);
			if (environmentId === null) return;
			active = true;
			const epoch = `keybindings:${context.generation}:${crypto.randomUUID()}`;
			let version = 0;
			const program = Stream.runForEach(
				context.client["keybindings.stream"](),
				(file) =>
					Effect.sync(() => {
						if (!active || !context.isCurrent()) return;
						const data = resolveRules([...file.rules]);
						version += 1;
						context.emit({
							data,
							cursor: { epoch, version },
							resetEpoch: version === 1,
							sync: "live",
						});
						publishMenuAccelerators(data.resolvedRules);
					}),
			).pipe(
				Effect.andThen(
					Effect.fail(new Error("Keybindings stream ended unexpectedly")),
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

registerRendererResourceDriver("environment-keybindings", (key) =>
	environmentFrom(key) === null
		? null
		: (makeDriver() as ResourceDriver<MemoizeClient, unknown>),
);

const activeResource = () => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore.getState().activeEnvironmentId,
	);
	return {
		environmentId,
		key: keyFor(environmentId),
		bus: getRendererClientBus(),
	};
};

export const keybindingsSnapshot = (): EnvironmentKeybindingsData => {
	const { bus, key } = activeResource();
	return bus.snapshot(key)?.data ?? FALLBACK;
};

export const subscribeKeybindings = (listener: () => void): (() => void) => {
	const { bus, key } = activeResource();
	return bus.subscribe(key, listener);
};

export const setUserKeybindings = async (
	rules: ReadonlyArray<KeybindingRule>,
): Promise<void> => {
	const clamped =
		rules.length > MAX_KEYBINDING_RULES
			? rules.slice(rules.length - MAX_KEYBINDING_RULES)
			: rules;
	const { environmentId, key, bus } = activeResource();
	const receipt = await bus.dispatch<KeybindingsFile>({
		kind: "keybindings.replace",
		commandId: CommandId.make(`keybindings-replace:${crypto.randomUUID()}`),
		environmentId,
		resource: key,
		payload: { rules: clamped },
		retry: "never",
		createdAt: Date.now(),
	});
	const data = resolveRules([...receipt.result.rules]);
	bus.overlay(key, { update: () => data });
	publishMenuAccelerators(data.resolvedRules);
};

const ACTIONS = {
	setUserRules: setUserKeybindings,
	resetAll: () => setUserKeybindings([]),
	resetCommand: (command: Command) =>
		setUserKeybindings(
			keybindingsSnapshot().userRules.filter(
				(rule) => rule.command !== command,
			),
		),
	addRule: (rule: KeybindingRule) =>
		setUserKeybindings([...keybindingsSnapshot().userRules, rule]),
	replaceUserRuleAt: (index: number, rule: KeybindingRule) => {
		const next = [...keybindingsSnapshot().userRules];
		if (index < 0 || index >= next.length) return Promise.resolve();
		next[index] = rule;
		return setUserKeybindings(next);
	},
	removeUserRuleAt: (index: number) => {
		const next = [...keybindingsSnapshot().userRules];
		if (index < 0 || index >= next.length) return Promise.resolve();
		next.splice(index, 1);
		return setUserKeybindings(next);
	},
};

export const useKeybindings = <Selected>(
	selector: (state: KeybindingsState) => Selected,
): Selected => {
	const environmentId = EnvironmentId.make(
		useEnvironmentCatalogStore((state) => state.activeEnvironmentId),
	);
	const key = useMemo(() => keyFor(environmentId), [environmentId]);
	const bus = getRendererClientBus();
	useEffect(
		() => bus.retain(key, { activation: "connect" }).release,
		[bus, key],
	);
	const view = useSyncExternalStore(
		(listener) => bus.subscribe(key, listener),
		() => bus.snapshot(key),
	);
	return selector({
		...(view.data ?? FALLBACK),
		...ACTIONS,
		loaded: view.data !== null,
		error: view.sync === "failed" ? "Unable to synchronize keybindings" : null,
	});
};
