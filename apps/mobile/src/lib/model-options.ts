import {
  defaultModelFor,
  MODELS_BY_PROVIDER,
  type PermissionMode,
  type ProviderId,
  type RuntimeMode,
} from "@zuse/wire";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  gemini: "Gemini",
  opencode: "OpenCode",
};

export const RUNTIME_OPTIONS: readonly {
  value: RuntimeMode;
  label: string;
}[] = [
  { value: "approval-required", label: "Ask first" },
  { value: "auto-accept-edits", label: "Auto edits" },
  { value: "auto-accept-edits-and-bash", label: "Auto edits + shell" },
  { value: "full-access", label: "Full access" },
];

export const PERMISSION_OPTIONS: readonly {
  value: PermissionMode;
  label: string;
}[] = [
  { value: "default", label: "Build" },
  { value: "plan", label: "Plan" },
  { value: "acceptEdits", label: "Accept edits" },
];

export const providerOptions = () =>
  (Object.keys(MODELS_BY_PROVIDER) as ProviderId[]).map((providerId) => ({
    value: providerId,
    label: PROVIDER_LABEL[providerId],
  }));

export const modelOptionsForProvider = (providerId: ProviderId) =>
  (MODELS_BY_PROVIDER[providerId] ?? []).map((model) => ({
    value: model.id,
    label: model.label,
  }));

export const defaultModelForProvider = (providerId: ProviderId): string =>
  defaultModelFor(providerId);
