import { Effect, Fiber, Stream } from "effect";
import { create } from "zustand";

import type { AgentDefinition, SettingsFile } from "@zuse/wire";

import { getRpcClient } from "../lib/rpc-client";
import {
  DEFAULT_SUBAGENT_PRESETS,
  type SubagentPreset,
} from "../lib/subagent-presets";

/**
 * Per-preset overlay matching the wire `SubagentPresetState` shape. Storing
 * a partial overlay (not a cloned `AgentDefinition`) lets a new memoize
 * build update the seed prompts/models without retroactively losing user
 * tweaks.
 */
interface PresetState {
  readonly enabled: boolean;
  readonly overrides: Partial<AgentDefinition>;
}

interface SubagentsState {
  readonly enableForNewSessions: boolean;
  readonly presets: Record<string, PresetState>;
  readonly setEnableForNewSessions: (v: boolean) => void;
  readonly setPresetEnabled: (name: string, enabled: boolean) => void;
  readonly setPresetOverride: (
    name: string,
    override: Partial<AgentDefinition>,
  ) => void;
}

const defaultPresetsState = (): Record<string, PresetState> => {
  const out: Record<string, PresetState> = {};
  for (const seed of DEFAULT_SUBAGENT_PRESETS) {
    out[seed.name] = { enabled: true, overrides: {} };
  }
  return out;
};

/** Mirror the subagents slice from a server `SettingsFile`. */
const sliceFromFile = (
  file: SettingsFile,
): { enableForNewSessions: boolean; presets: Record<string, PresetState> } => {
  // Seed defaults so newly-added presets in code show up even if the
  // user's file hasn't been touched.
  const presets: Record<string, PresetState> = defaultPresetsState();
  for (const [name, state] of Object.entries(file.subagents.presets)) {
    presets[name] = {
      enabled: state.enabled,
      overrides: { ...state.overrides },
    };
  }
  return {
    enableForNewSessions: file.subagents.enableForNewSessions,
    presets,
  };
};

let streamFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;

const stopStream = async () => {
  if (streamFiber !== null) {
    const f = streamFiber;
    streamFiber = null;
    await Effect.runPromise(Fiber.interrupt(f));
  }
};

/**
 * Push the current presets state up to the main process. Subagents are
 * persisted inside `settings.json`, so we send a `subagents` patch that
 * carries the whole slice — the main process replaces it wholesale.
 */
const pushPresets = async (
  enableForNewSessions: boolean,
  presets: Record<string, PresetState>,
): Promise<void> => {
  const client = await getRpcClient();
  await Effect.runPromise(
    client.settings.update({
      patch: {
        subagents: {
          enableForNewSessions,
          presets,
        },
      },
    }),
  );
};

export const useSubagentsStore = create<SubagentsState>((set, get) => ({
  enableForNewSessions: true,
  presets: defaultPresetsState(),
  setEnableForNewSessions: (v) => {
    set({ enableForNewSessions: v });
    void pushPresets(v, get().presets);
  },
  setPresetEnabled: (name, enabled) => {
    const cur = get().presets[name] ?? { enabled: true, overrides: {} };
    const next = { ...get().presets, [name]: { ...cur, enabled } };
    set({ presets: next });
    void pushPresets(get().enableForNewSessions, next);
  },
  setPresetOverride: (name, override) => {
    const cur = get().presets[name] ?? { enabled: true, overrides: {} };
    const next = {
      ...get().presets,
      [name]: { ...cur, overrides: { ...cur.overrides, ...override } },
    };
    set({ presets: next });
    void pushPresets(get().enableForNewSessions, next);
  },
}));

/**
 * Hydrate the subagents store from `settings.get` + `settings.stream`.
 * Kept separate from useSettingsStore.hydrate to avoid a single fiber
 * owning the lifecycle of two stores — they boot in parallel.
 */
export async function hydrateSubagentsStore(): Promise<void> {
  try {
    const client = await getRpcClient();
    const file = await Effect.runPromise(client.settings.get());
    useSubagentsStore.setState(sliceFromFile(file));

    await stopStream();
    streamFiber = Effect.runFork(
      Stream.runForEach(client.settings.stream(), (next) =>
        Effect.sync(() => useSubagentsStore.setState(sliceFromFile(next))),
      ),
    );
  } catch {
    // Stay on defaults if RPC fails.
  }
}

/**
 * Merge the seed and the user's overlay into the live `AgentDefinition`
 * the wire ships to the server. Used by the new-session create path.
 */
export const resolvePresetDefinition = (
  preset: SubagentPreset,
  overrides: Partial<AgentDefinition>,
): AgentDefinition => ({
  ...preset.definition,
  ...overrides,
});

/**
 * Build the `agents` map for a Claude session.create payload. Only
 * enabled presets are included; an empty result means the session
 * starts without sub-agents (unchanged from pre-feature behaviour).
 */
export const buildAgentsForNewSession = (): Readonly<
  Record<string, AgentDefinition>
> => {
  const state = useSubagentsStore.getState();
  if (!state.enableForNewSessions) return {};
  const out: Record<string, AgentDefinition> = {};
  for (const preset of DEFAULT_SUBAGENT_PRESETS) {
    const ps = state.presets[preset.name];
    if (ps && !ps.enabled) continue;
    out[preset.name] = resolvePresetDefinition(
      preset,
      ps?.overrides ?? {},
    );
  }
  return out;
};
