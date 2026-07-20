import { Host } from "@expo/ui";
import {
	Divider,
	Menu,
	Button as NativeButton,
	Section,
} from "@expo/ui/swift-ui";
import type { PermissionMode, ProviderId, RuntimeMode } from "@zuse/contracts";

import {
	defaultModelOptions,
	modelOptionsForProvider,
	PERMISSION_OPTIONS,
	PROVIDER_LABEL,
	providerOptions,
	RUNTIME_OPTIONS,
	reasoningValueForModel,
	runtimeOptionFor,
} from "~/lib/model-options";
import { NEON_GREEN } from "~/theme";

export type ModelModeValue = {
	providerId: ProviderId;
	model: string;
	runtimeMode: RuntimeMode;
	permissionMode: PermissionMode;
	modelOptions?: Record<string, string>;
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
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu
				label={modelLabel(value)}
				systemImage={providerSystemImage(value.providerId)}
			>
				<ProviderModelMenus
					value={value}
					editable={editable}
					onChange={onChange}
				/>
				<Divider />
				<ModeButtons value={value} editable={editable} onChange={onChange} />
				<PermissionButtons
					value={value}
					editable={editable}
					onChange={onChange}
				/>
			</Menu>
		</Host>
	);
}

export function ComposerModelMenu({
	value,
	editable,
	onChange,
	availableProviders,
	canChangeProvider = true,
	canChangeReasoning = true,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
	/** Provider ids to show; `null`/`undefined` = no filtering (full catalog). */
	availableProviders?: readonly ProviderId[] | null;
	/** When false, only the current provider's model submenu is shown. */
	canChangeProvider?: boolean;
	/** When false, the reasoning/effort section is hidden. */
	canChangeReasoning?: boolean;
}) {
	return (
		// Re-mount the native Host on provider/model change: iOS UIMenu snapshots
		// its content when opened, so switching provider/model must rebuild the
		// menu to refresh the reasoning options on next open. The re-mount is
		// invisible because a model tap dismisses the menu first.
		<Host
			key={`${value.providerId}:${value.model}`}
			matchContents
			seedColor={NEON_GREEN}
		>
			<Menu
				label={compactModelLabel(value)}
				systemImage={providerSystemImage(value.providerId)}
			>
				<ProviderModelMenus
					value={value}
					editable={editable}
					onChange={onChange}
					availableProviders={availableProviders}
					canChangeProvider={canChangeProvider}
				/>
				{canChangeReasoning ? (
					<ReasoningButtons
						value={value}
						editable={editable}
						onChange={onChange}
					/>
				) : null}
			</Menu>
		</Host>
	);
}

export function ComposerSettingsMenu({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	return (
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu label="" systemImage="gearshape">
				<Menu label="Mode" systemImage="slider.horizontal.3">
					<ModeButtons value={value} editable={editable} onChange={onChange} />
				</Menu>
				<Menu label="Approval" systemImage="hand.raised">
					<PermissionButtons
						value={value}
						editable={editable}
						onChange={onChange}
					/>
				</Menu>
			</Menu>
		</Host>
	);
}

export const ComposerModeMenu = ComposerSettingsMenu;
export const ComposerApprovalMenu = ComposerSettingsMenu;

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
		<Host matchContents seedColor={NEON_GREEN}>
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
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu label={runtimeLabel(value)} systemImage="lock.open">
				<PermissionButtons
					value={value}
					editable={editable}
					onChange={onChange}
				/>
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
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu
				label={modelLabel(value)}
				systemImage={providerSystemImage(value.providerId)}
			>
				<ProviderModelMenus
					value={value}
					editable={editable}
					onChange={onChange}
				/>
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
		<Host matchContents seedColor={NEON_GREEN}>
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
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu label={label} systemImage="folder">
				{projects.length === 0 ? (
					<NativeButton
						label="No projects"
						systemImage="folder"
						onPress={() => {}}
					/>
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
		<Host matchContents seedColor={NEON_GREEN}>
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
		<Host matchContents seedColor={NEON_GREEN}>
			<Menu label={`${label} · ${subtitle}`} systemImage="desktopcomputer">
				{options.map((group) => (
					<Menu
						key={group.connectionKey}
						label={group.connectionLabel}
						systemImage="desktopcomputer"
					>
						{group.projects.length === 0 ? (
							<NativeButton
								label="No projects"
								systemImage="folder"
								onPress={() => {}}
							/>
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
		<Host matchContents seedColor={NEON_GREEN}>
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
	availableProviders,
	canChangeProvider = true,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
	availableProviders?: readonly ProviderId[] | null;
	canChangeProvider?: boolean;
}) {
	const providers = providerOptions().filter((provider) => {
		// Locked to the current provider mid-session (provider swaps need a fresh
		// chat) — show only its model submenu.
		if (!canChangeProvider) return provider.value === value.providerId;
		// Hide providers whose CLI isn't installed; keep the current provider so a
		// stale selection never vanishes from the menu.
		if (availableProviders == null) return true;
		return (
			provider.value === value.providerId ||
			availableProviders.includes(provider.value)
		);
	});
	return (
		<Section title="Models">
			{providers.map((provider) => (
				<Menu
					key={provider.value}
					label={provider.label}
					systemImage={providerSystemImage(provider.value)}
				>
					{modelOptionsForProvider(provider.value).map((model) => (
						<NativeButton
							key={model.value}
							label={model.label}
							systemImage={
								value.providerId === provider.value &&
								value.model === model.value
									? sf("checkmark")
									: undefined
							}
							onPress={() => {
								if (!editable) return;
								onChange({
									...value,
									providerId: provider.value,
									model: model.value,
									modelOptions: defaultModelOptions(
										provider.value,
										model.value,
									),
								});
							}}
						/>
					))}
				</Menu>
			))}
		</Section>
	);
}

// Reasoning/effort levels get an ascending gauge glyph (low → high) so the menu
// reads as "increasing" instead of a flat brain icon on every row. The active
// level is reflected by the composer trigger label, so we intentionally show
// the level glyph on every row rather than a checkmark.
const REASONING_GAUGE_ICONS = [
	"gauge.with.dots.needle.0percent",
	"gauge.with.dots.needle.33percent",
	"gauge.with.dots.needle.67percent",
	"gauge.with.dots.needle.100percent",
] as const;

const reasoningLevelIcon = (index: number, count: number): string => {
	if (count <= 1) return REASONING_GAUGE_ICONS[2];
	const ratio = index / (count - 1);
	return (
		REASONING_GAUGE_ICONS[
			Math.round(ratio * (REASONING_GAUGE_ICONS.length - 1))
		] ?? REASONING_GAUGE_ICONS[2]
	);
};

function ReasoningButtons({
	value,
	editable,
	onChange,
}: {
	value: ModelModeValue;
	editable: boolean;
	onChange: (value: ModelModeValue) => void;
}) {
	const reasoning = reasoningValueForModel(
		value.providerId,
		value.model,
		value.modelOptions,
	);
	if (reasoning === null) return null;

	const options = reasoning.descriptor.options;
	return (
		<Section title={reasoning.descriptor.label}>
			{options.map((option, index) => (
				<NativeButton
					key={option.id}
					label={option.label}
					systemImage={sf(reasoningLevelIcon(index, options.length))}
					onPress={() => {
						if (!editable) return;
						onChange({
							...value,
							modelOptions: {
								...(value.modelOptions ?? {}),
								[reasoning.descriptor.id]: option.id,
							},
						});
					}}
				/>
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
					systemImage={sf(
						value.permissionMode === item.value
							? "checkmark"
							: "wand.and.stars",
					)}
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
					systemImage={sf(
						value.runtimeMode === item.value ? "checkmark" : item.systemImage,
					)}
					role={item.value === "full-access" ? "destructive" : undefined}
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
	[
		shortModelLabel(modelLabel(value)),
		reasoningValueForModel(value.providerId, value.model, value.modelOptions)
			?.label,
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");

const shortModelLabel = (label: string): string => {
	const trimmed = label
		.replace(/^GPT-?/i, "")
		.replace(/^Claude\s+/i, "")
		.trim();
	return trimmed.length > 0 ? trimmed : label;
};

const modeLabel = (value: ModelModeValue): string =>
	PERMISSION_OPTIONS.find((item) => item.value === value.permissionMode)
		?.label ?? value.permissionMode;

const runtimeLabel = (value: ModelModeValue): string =>
	runtimeOptionFor(value.runtimeMode).label;

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
