import { Host } from "@expo/ui";
import {
  Button as NativeButton,
  Divider,
  Menu,
  Section,
} from "@expo/ui/swift-ui";
import type { PermissionMode, ProviderId, RuntimeMode } from "@zuse/wire";

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
        label={modelLabel(value)}
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

export function ComposerModelMenu({
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
        label={compactModelLabel(value)}
        systemImage={providerSystemImage(value.providerId)}
      >
        <ProviderModelMenus value={value} editable={editable} onChange={onChange} />
      </Menu>
    </Host>
  );
}

export function ComposerModeMenu({
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
      <Menu label={modeLabel(value)} systemImage="slider.horizontal.3">
        <ModeButtons value={value} editable={editable} onChange={onChange} />
      </Menu>
    </Host>
  );
}

export function ComposerApprovalMenu({
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
      <Menu label={approvalShortLabel(value)} systemImage="hand.raised">
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
        label={modeLabel(value)}
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
        label={runtimeLabel(value)}
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
        label={modelLabel(value)}
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
        label={modeLabel(value)}
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
  const projects = options.flatMap((group) =>
    group.projects.map((project) => ({
      ...project,
      connectionKey: group.connectionKey,
    })),
  );

  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu label={label} systemImage="folder">
        {projects.length === 0 ? (
          <NativeButton label="No projects" systemImage="folder" onPress={() => {}} />
        ) : (
          projects.map((project) => (
            <NativeButton
              key={`${project.connectionKey}:${project.id}`}
              label={project.name}
              systemImage="folder"
              onPress={() => onSelect(project.connectionKey, project.id)}
            />
          ))
        )}
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
        label={label}
        systemImage="point.topleft.down.curvedto.point.bottomright.up"
      >
        {children}
      </Menu>
    </Host>
  );
}

export function ProjectMenuRow({
  label,
  subtitle,
  options,
  onSelect,
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
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu
        label={`${label} · ${subtitle}`}
        systemImage="desktopcomputer"
      >
        {options.map((group) => (
          <Menu
            key={group.connectionKey}
            label={group.connectionLabel}
            systemImage="desktopcomputer"
          >
            {group.projects.length === 0 ? (
              <NativeButton label="No projects" systemImage="folder" onPress={() => {}} />
            ) : (
              group.projects.map((project) => (
                <NativeButton
                  key={project.id}
                  label={project.name}
                  systemImage="folder"
                  onPress={() => onSelect(group.connectionKey, project.id)}
                />
              ))
            )}
          </Menu>
        ))}
      </Menu>
    </Host>
  );
}

export function SourceMenuRow({
  label,
  subtitle,
  children,
}: {
  label: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Host matchContents seedColor="hsl(72 98% 54%)" colorScheme="dark">
      <Menu
        label={`${label} · ${subtitle}`}
        systemImage="bubble.left.and.bubble.right"
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
    <Section title="Approval">
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

const modelLabel = (value: ModelModeValue): string =>
  modelOptionsForProvider(value.providerId).find(
    (model) => model.value === value.model,
  )?.label ?? value.model;

const compactModelLabel = (value: ModelModeValue): string =>
  shortModelLabel(modelLabel(value));

const shortModelLabel = (label: string): string => {
  const trimmed = label.replace(/^GPT-?/i, "").replace(/^Claude\s+/i, "").trim();
  return trimmed.length > 0 ? trimmed : label;
};

const modeLabel = (value: ModelModeValue): string =>
  PERMISSION_OPTIONS.find((item) => item.value === value.permissionMode)?.label ??
  value.permissionMode;

const runtimeLabel = (value: ModelModeValue): string =>
  RUNTIME_OPTIONS.find((item) => item.value === value.runtimeMode)?.label ??
  value.runtimeMode;

const approvalShortLabel = (value: ModelModeValue): string => {
  switch (value.runtimeMode) {
    case "approval-required":
      return "Ask";
    case "auto-accept-edits":
      return "Edits";
    case "auto-accept-edits-and-bash":
      return "Shell";
    case "full-access":
      return "Full";
  }
};

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
