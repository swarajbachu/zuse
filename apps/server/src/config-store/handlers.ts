import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { ConfigStoreService } from "./services/config-store-service.ts";

/* ───────── settings.* ───────── */

const SettingsGet = MemoizeRpcs.toLayerHandler("settings.get", () =>
  Effect.flatMap(ConfigStoreService, (svc) => svc.getSettings()),
);

const SettingsUpdate = MemoizeRpcs.toLayerHandler(
  "settings.update",
  ({ patch }) =>
    Effect.flatMap(ConfigStoreService, (svc) => svc.updateSettings(patch)),
);

const SettingsStream = MemoizeRpcs.toLayerHandler("settings.stream", () =>
  Stream.unwrap(
    Effect.map(ConfigStoreService, (svc) => svc.settingsChanges()),
  ),
);

const SettingsMigrate = MemoizeRpcs.toLayerHandler(
  "settings.migrateLocalStorage",
  (payload) =>
    Effect.flatMap(ConfigStoreService, (svc) =>
      svc.migrateLocalStorage(payload),
    ),
);

/* ───────── keybindings.* ───────── */

const KeybindingsGet = MemoizeRpcs.toLayerHandler("keybindings.get", () =>
  Effect.flatMap(ConfigStoreService, (svc) => svc.getKeybindings()),
);

const KeybindingsReplace = MemoizeRpcs.toLayerHandler(
  "keybindings.replace",
  ({ rules }) =>
    Effect.flatMap(ConfigStoreService, (svc) => svc.replaceKeybindings(rules)),
);

const KeybindingsStream = MemoizeRpcs.toLayerHandler("keybindings.stream", () =>
  Stream.unwrap(
    Effect.map(ConfigStoreService, (svc) => svc.keybindingsChanges()),
  ),
);

export const ConfigStoreHandlersLayer = Layer.mergeAll(
  SettingsGet,
  SettingsUpdate,
  SettingsStream,
  SettingsMigrate,
  KeybindingsGet,
  KeybindingsReplace,
  KeybindingsStream,
);
