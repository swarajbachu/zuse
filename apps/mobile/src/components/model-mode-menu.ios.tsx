import { Host } from "@expo/ui";
import {
  Button as NativeButton,
  Divider,
  Menu,
  Section,
} from "@expo/ui/swift-ui";
import type { PermissionMode, ProviderId, RuntimeMode } from "@zuse/wire";
import { Text, View } from "react-native";

import {
  modelOptionsForProvider,
  PERMISSION_OPTIONS,
  PROVIDER_LABEL,
  providerOptions,
  RUNTIME_OPTIONS,
} from "~/lib/model-options";

export type ModelModeValue = {
  providerId: ProviderId;
  model: string;
  runtimeMode: RuntimeMode;
  permissionMode: PermissionMode;
};

export function ModelModePill({
  value,
  editable,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu
        label={<PillLabel label={modelLabel(value)} tone="brand" />}
        systemImage={providerSystemImage(value.providerId)}
      >
        <ProviderModelMenus value={value} editable={editable} onChange={onChange} />
        <Divider />
        <ModeButtons value={value} editable={editable} onChange={onChange} />
        <PermissionButtons value={value} editable={editable} onChange={onChange} />
      </Menu>
    </Host>
  );
}

export function ModePill({
  value,
  editable,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu
        label={<PillLabel label={modeLabel(value)} />}
        systemImage="chevron.left.forwardslash.chevron.right"
      >
        <ModeButtons value={value} editable={editable} onChange={onChange} />
      </Menu>
    </Host>
  );
}

export function RuntimePill({
  value,
  editable,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu
        label={<PillLabel label={runtimeLabel(value)} />}
        systemImage="lock.open"
      >
        <PermissionButtons value={value} editable={editable} onChange={onChange} />
      </Menu>
    </Host>
  );
}

export function StaticModelTitle({
  value,
  editable,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu
        label={
          <View className="flex-row items-center gap-1 px-2 py-1">
            <Text className="font-sans-bold text-[20px] text-foreground" numberOfLines={1}>
              {modelLabel(value)}
            </Text>
            <Text className="font-sans-bold text-[18px] text-foreground/80">⌄</Text>
          </View>
        }
        systemImage={providerSystemImage(value.providerId)}
      >
        <ProviderModelMenus value={value} editable={editable} onChange={onChange} />
      </Menu>
    </Host>
  );
}

export function HeaderModePill({
  value,
  editable,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu
        label={<PillLabel label={modeLabel(value)} muted />}
        systemImage="chevron.left.forwardslash.chevron.right"
      >
        <ModeButtons value={value} editable={editable} onChange={onChange} />
      </Menu>
    </Host>
  );
}

export function ProjectPill({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: readonly {
    connectionKey: string;
    connectionLabel: string;
    projects: readonly { id: string; name: string; path: string }[];
  }[];
  onSelect: (connectionKey: string, projectId: string) => void;
}) {
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu label={<PillLabel label={label} />} systemImage="folder">
        {options.map((group) => (
          <Menu
            key={group.connectionKey}
            label={group.connectionLabel}
            systemImage="desktopcomputer"
          >
            {group.projects.map((project) => (
              <NativeButton
                key={project.id}
                label={project.name}
                systemImage="folder"
                onPress={() => onSelect(group.connectionKey, project.id)}
              />
            ))}
          </Menu>
        ))}
      </Menu>
    </Host>
  );
}

export function SourcePill({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu
        label={<PillLabel label={label} />}
        systemImage="point.topleft.down.curvedto.point.bottomright.up"
      >
        {children}
      </Menu>
    </Host>
  );
}

export { Divider, Menu, NativeButton, Section };

function ProviderModelMenus({
  value,
  editable,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  return (
    <Section title="Models">
      {providerOptions().map((provider) => (
        <Menu
          key={provider.value}
          label={provider.label}
          systemImage={providerSystemImage(provider.value)}
        >
          {modelOptionsForProvider(provider.value).map((model) => (
            <NativeButton
              key={model.value}
              label={model.label}
              systemImage={sf(
                value.providerId === provider.value && value.model === model.value
                  ? "checkmark"
                  : providerSystemImage(provider.value),
              )}
              onPress={() => {
                if (!editable) return;
                onChange({
                  ...value,
                  providerId: provider.value,
                  model: model.value,
                });
              }}
            />
          ))}
        </Menu>
      ))}
    </Section>
  );
}

function ModeButtons({
  value,
  editable,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  return (
    <Section title="Mode">
      {PERMISSION_OPTIONS.map((item) => (
        <NativeButton
          key={item.value}
          label={item.label}
          systemImage={sf(value.permissionMode === item.value ? "checkmark" : "wand.and.stars")}
          onPress={() => {
            if (!editable) return;
            onChange({ ...value, permissionMode: item.value });
          }}
        />
      ))}
    </Section>
  );
}

function PermissionButtons({
  value,
  editable,
  onChange,
}: {
  value: ModelModeValue;
  editable: boolean;
  onChange: (value: ModelModeValue) => void;
}) {
  return (
    <Section title="Permissions">
      {RUNTIME_OPTIONS.map((item) => (
        <NativeButton
          key={item.value}
          label={item.label}
          systemImage={sf(value.runtimeMode === item.value ? "checkmark" : "lock.open")}
          onPress={() => {
            if (!editable) return;
            onChange({ ...value, runtimeMode: item.value });
          }}
        />
      ))}
    </Section>
  );
}

function PillLabel({
  label,
  muted,
  tone,
}: {
  label: string;
  muted?: boolean;
  tone?: "brand";
}) {
  return (
    <View
      className={
        tone === "brand"
          ? "rounded-full bg-primary/12 px-3 py-2"
          : "rounded-full border border-border bg-card-elevated px-3 py-2"
      }
      style={{ borderCurve: "continuous" }}
    >
      <Text
        className={
          muted
            ? "font-sans-medium text-[14px] text-muted-foreground"
            : "font-sans-medium text-[14px] text-foreground"
        }
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const modelLabel = (value: ModelModeValue): string =>
  modelOptionsForProvider(value.providerId).find(
    (model) => model.value === value.model,
  )?.label ?? value.model;

const modeLabel = (value: ModelModeValue): string =>
  PERMISSION_OPTIONS.find((item) => item.value === value.permissionMode)?.label ??
  value.permissionMode;

const runtimeLabel = (value: ModelModeValue): string =>
  RUNTIME_OPTIONS.find((item) => item.value === value.runtimeMode)?.label ??
  value.runtimeMode;

const providerSystemImage = (providerId: ProviderId): string => {
  switch (providerId) {
    case "claude":
      return "cloud";
    case "codex":
      return "terminal";
    case "grok":
      return "sparkles";
    case "cursor":
      return "cursorarrow";
    case "gemini":
      return "diamond";
    case "opencode":
      return "chevron.left.forwardslash.chevron.right";
  }
};

const sf = (name: string) => name as never;

export const providerDisplayName = (providerId: ProviderId): string =>
  PROVIDER_LABEL[providerId];
