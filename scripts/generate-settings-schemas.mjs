import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const outDir = join(process.cwd(), "apps", "web", "public", "schemas");
const check = process.argv.includes("--check");
const pending = [];

const providerIds = ["claude", "codex", "grok", "gemini", "cursor", "opencode"];
const runtimeModes = [
  "approval-required",
  "auto-accept-edits",
  "auto-accept-edits-and-bash",
  "full-access",
];
const appearanceModes = ["system", "light", "dark"];
const completionSounds = ["chime", "soft", "pop", "bell", "rise", "bloom"];
const branchNamingStyles = ["username-slug", "slug", "feat-slug", "custom"];
const mergeMethods = ["merge", "squash", "rebase"];
const commands = [
  "new-chat",
  "open-project",
  "settings",
  "close-tab",
  "toggle-left-sidebar",
  "toggle-right-sidebar",
  "toggle-terminal",
  "focus-composer",
  "next-tab",
  "prev-tab",
  "select-tab-1",
  "select-tab-2",
  "select-tab-3",
  "select-tab-4",
  "select-tab-5",
  "select-tab-6",
  "select-tab-7",
  "select-tab-8",
  "select-last-tab",
  "new-tab",
  "next-chat",
  "prev-chat",
  "next-panel",
  "prev-panel",
  "focus-next-pane",
  "focus-prev-pane",
  "open-chat-switcher",
  "composer.submit",
  "composer.newline",
  "composer.forceSubmit",
  "composer.togglePlanMode",
  "editor.save",
  "editor.annotate",
];

const stringMap = {
  type: "object",
  additionalProperties: { type: "string" },
};

const boolMap = {
  type: "object",
  additionalProperties: { type: "boolean" },
};

const nullableString = {
  anyOf: [{ type: "string" }, { type: "null" }],
};

const nullableEnum = (values) => ({
  anyOf: [{ enum: values }, { type: "null" }],
});

const writeSchema = (name, schema) => {
  const filePath = join(outDir, name);
  const serialized = `${JSON.stringify(schema, null, 2)}\n`;
  if (check) {
    const current = existsSync(filePath)
      ? readFileSync(filePath, "utf8")
      : null;
    if (current !== serialized) pending.push(name);
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serialized, "utf8");
};

writeSchema("repository-settings.schema.json", {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://zuse.dev/schemas/repository-settings.schema.json",
  title: "Zuse Repository Settings",
  description: "Committed repository settings for .zuse/settings.toml.",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    defaultProviderId: nullableEnum(providerIds),
    defaultModel: nullableString,
    defaultRuntimeMode: nullableEnum(runtimeModes),
    autoCreateWorktree: { type: "boolean" },
    worktreeBaseDir: nullableString,
    file_include_globs: {
      anyOf: [
        {
          type: "array",
          items: { type: "string" },
        },
        {
          type: "string",
          description: "Legacy newline-separated pattern list.",
        },
      ],
      description:
        "Patterns linked from the main checkout into every Zuse worktree.",
    },
    scripts: {
      type: "object",
      additionalProperties: false,
      properties: {
        setup: nullableString,
        run: nullableString,
        archive: nullableString,
        auto_run_after_setup: { type: "boolean" },
      },
    },
    environment_variables: stringMap,
  },
});

writeSchema("settings.schema.json", {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://zuse.dev/schemas/settings.schema.json",
  title: "Zuse User Settings",
  description: "User-level settings stored in ~/.zuse/settings.json.",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "defaultProviderId",
    "defaultModelByProvider",
    "defaultRuntimeMode",
    "defaultAutoCreateWorktree",
    "onboardingCompleted",
    "appearanceMode",
    "completionSoundEnabled",
    "completionSoundPreset",
    "providerEnabled",
    "modelEnabledByProvider",
    "subagents",
    "branchNamingStyle",
    "branchNamingPrefix",
    "mergePrefs",
    "notchTrayEnabled",
    "notchTrayPinned",
  ],
  properties: {
    schemaVersion: { const: 1 },
    defaultProviderId: { enum: providerIds },
    defaultModelByProvider: stringMap,
    defaultRuntimeMode: { enum: runtimeModes },
    defaultAutoCreateWorktree: { type: "boolean" },
    onboardingCompleted: { type: "boolean" },
    appearanceMode: { enum: appearanceModes },
    completionSoundEnabled: { type: "boolean" },
    completionSoundPreset: { enum: completionSounds },
    providerEnabled: boolMap,
    modelEnabledByProvider: {
      type: "object",
      additionalProperties: boolMap,
    },
    subagents: {
      type: "object",
      additionalProperties: false,
      required: ["enableForNewSessions", "presets"],
      properties: {
        enableForNewSessions: { type: "boolean" },
        presets: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: true,
            required: ["enabled", "overrides"],
            properties: {
              enabled: { type: "boolean" },
              overrides: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    branchNamingStyle: { enum: branchNamingStyles },
    branchNamingPrefix: { type: "string" },
    mergePrefs: {
      type: "object",
      additionalProperties: false,
      required: ["method", "deleteBranch"],
      properties: {
        method: { enum: mergeMethods },
        deleteBranch: { type: "boolean" },
      },
    },
    notchTrayEnabled: { type: "boolean" },
    notchTrayPinned: { type: "boolean" },
  },
});

writeSchema("keybindings.schema.json", {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://zuse.dev/schemas/keybindings.schema.json",
  title: "Zuse Keybindings",
  description: "User keybinding overrides stored in ~/.zuse/keybindings.json.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "rules"],
  properties: {
    schemaVersion: { const: 1 },
    rules: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "command"],
        properties: {
          key: { type: "string" },
          command: { enum: commands },
          when: { type: "string" },
        },
      },
    },
  },
});

if (pending.length > 0) {
  console.error(`Schema files are out of date: ${pending.join(", ")}`);
  process.exit(1);
}
