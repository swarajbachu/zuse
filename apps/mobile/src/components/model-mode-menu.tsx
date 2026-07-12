import type { PermissionMode, ProviderId, RuntimeMode } from "@zuse/contracts";
import { Pressable, Text } from "react-native";

import { modelOptionsForProvider } from "~/lib/model-options";

export type ModelModeValue = {
  providerId: ProviderId;
  model: string;
  runtimeMode: RuntimeMode;
  permissionMode: PermissionMode;
  modelOptions?: Record<string, string>;
};

export function ModelModePill({
  value,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  const modelLabel =
    modelOptionsForProvider(value.providerId).find(
      (model) => model.value === value.model,
    )?.label ?? value.model;
  return <FallbackPill label={modelLabel} />;
}

export function ComposerModelMenu({
  value,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
  // Inert on non-iOS; kept to mirror the native twin's signature.
  availableProviders?: readonly ProviderId[] | null;
  canChangeProvider?: boolean;
  canChangeReasoning?: boolean;
}) {
  const modelLabel =
    modelOptionsForProvider(value.providerId).find(
      (model) => model.value === value.model,
    )?.label ?? value.model;
  return <FallbackPill label={modelLabel} />;
}

export const ComposerSettingsMenu = ({ value }: ModelModeProps) => (
  <FallbackPill label={value.permissionMode} />
);

export const ComposerModeMenu = ComposerSettingsMenu;
export const ComposerApprovalMenu = ComposerSettingsMenu;

export const ModePill = ({ value }: ModelModeProps) => (
  <FallbackPill label={value.permissionMode} />
);

export const RuntimePill = ({ value }: ModelModeProps) => (
  <FallbackPill label={value.runtimeMode} />
);

export const StaticModelTitle = ({ value }: ModelModeProps) => {
  const modelLabel =
    modelOptionsForProvider(value.providerId).find(
      (model) => model.value === value.model,
    )?.label ?? value.model;
  return <FallbackPill label={modelLabel} />;
};

export const HeaderModePill = ({ value }: ModelModeProps) => (
  <FallbackPill label={value.permissionMode} />
);

export function ProjectPill({
  label,
}: {
  label: string;
  options: readonly {
    connectionKey: string;
    connectionLabel: string;
    projects: readonly { id: string; name: string; path: string }[];
  }[];
  onSelect: (connectionKey: string, projectId: string) => void;
}) {
  return <FallbackPill label={label} />;
}

export function SourcePill({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return <FallbackPill label={label} />;
}

export function ProjectMenuRow({
  label,
  subtitle,
}: {
  label: string;
  subtitle: string;
  options: readonly {
    connectionKey: string;
    connectionLabel: string;
    projects: readonly { id: string; name: string; path: string }[];
  }[];
  onSelect: (connectionKey: string, projectId: string) => void;
}) {
  return <FallbackPill label={`${label} · ${subtitle}`} />;
}

export function SourceMenuRow({
  label,
  subtitle,
}: {
  label: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return <FallbackPill label={`${label} · ${subtitle}`} />;
}

export const NativeButton = (_props: {
  label: string;
  systemImage?: string;
  onPress?: () => void;
}) => null;
export const Menu = (_props: { label: string; children: React.ReactNode }) =>
  null;
export const Section = (_props: {
  title?: string;
  children: React.ReactNode;
}) => null;
export const Divider = () => null;

type ModelModeProps = {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
};

const FallbackPill = ({ label }: { label: string }) => (
  <Pressable
    className="rounded-full border border-border bg-card-elevated px-3 py-2 active:opacity-75"
    style={{ borderCurve: "continuous" }}
  >
    <Text
      className="font-sans-medium text-[14px] text-foreground"
      numberOfLines={1}
    >
      {label}
    </Text>
  </Pressable>
);
