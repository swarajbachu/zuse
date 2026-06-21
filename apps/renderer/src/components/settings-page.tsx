import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import {
  Alert01Icon,
  ArrowLeft01Icon,
  Delete02Icon,
  Folder01Icon,
  GitBranchIcon,
  GlobeIcon,
  KeyboardIcon,
  PackageIcon,
  RotateRight01Icon,
  Settings01Icon,
  TaskDone01Icon,
  TestTubeIcon,
  Tick01Icon,
  VolumeHighIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Effect } from "effect";

import { getRpcClient } from "../lib/rpc-client.ts";

import {
  type BranchNamingStyle,
  MODELS_BY_PROVIDER,
  type CompletionSoundPreset,
  type Folder,
  type FolderId,
  type ProviderId,
  type RuntimeMode,
} from "@memoize/wire";

import {
  formatRelativeTime,
  useRelativeTimeTick,
} from "~/lib/use-relative-time.ts";
import { cn } from "~/lib/utils";
import {
  COMPLETION_SOUND_PRESETS,
  playCompletionSound,
  prepareCompletionSound,
} from "../lib/completion-sounds.ts";
import { DEFAULT_SUBAGENT_PRESETS } from "../lib/subagent-presets.ts";
import { useProvidersStore } from "../store/providers.ts";
import { useSettingsStore } from "../store/settings.ts";
import { useSubagentsStore } from "../store/subagents.ts";
import { useUiStore, type SettingsSection } from "../store/ui.ts";
import { useWorkspaceStore } from "../store/workspace.ts";
import { ProviderCard } from "./provider-card.tsx";
import { ProviderIcon } from "./provider-icons.tsx";
import { MODES_ORDER, MODE_META } from "./runtime-mode-meta.ts";
import { DeveloperPane } from "./settings/developer-pane.tsx";
import { KeybindingsPane } from "./settings/keybindings-editor.tsx";
import { PokedexPane } from "./settings/pokedex-pane.tsx";
import { RepositorySettings } from "./settings-repository.tsx";
import { Button } from "./ui/button.tsx";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import { Switch } from "./ui/switch";
import { Frame, FrameFooter, FrameHeader } from "./ui/frame.tsx";
import { Card } from "./ui/card.tsx";

const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  gemini: "Gemini",
  opencode: "OpenCode",
};

type RailItemBase = {
  readonly id: string;
  readonly label: string;
  readonly Icon: IconSvgElement;
  readonly section: SettingsSection;
};

const TOP_RAIL: ReadonlyArray<RailItemBase> = [
  {
    id: "general",
    label: "General",
    Icon: Settings01Icon,
    section: { kind: "general" },
  },
  {
    id: "providers",
    label: "Providers",
    Icon: PackageIcon,
    section: { kind: "providers" },
  },
  {
    id: "workspace",
    label: "Workspace",
    Icon: GitBranchIcon,
    section: { kind: "workspace" },
  },
  {
    id: "pokedex",
    label: "Pokedex",
    Icon: TaskDone01Icon,
    section: { kind: "pokedex" },
  },
  {
    id: "browser",
    label: "Browser",
    Icon: GlobeIcon,
    section: { kind: "browser" },
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    Icon: KeyboardIcon,
    section: { kind: "shortcuts" },
  },
  // Dev-only visual playground (accent swatches + workflow chip/button
  // showcase). Filtered out of production bundles below.
  {
    id: "developer",
    label: "Developer",
    Icon: TestTubeIcon,
    section: { kind: "developer" },
  },
];

const VISIBLE_RAIL: ReadonlyArray<RailItemBase> = import.meta.env.DEV
  ? TOP_RAIL
  : TOP_RAIL.filter((i) => i.id !== "developer");

/**
 * Two-pane settings surface. The left rail navigates between global
 * sections (General / Models & Providers / Workspace) and per-repository
 * settings; the right pane renders the active section's form.
 */
export function SettingsPage() {
  const setView = useUiStore((s) => s.setView);
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.setSettingsSection);
  const folders = useWorkspaceStore((s) => s.folders);
  const loadFolders = useWorkspaceStore((s) => s.load);

  useEffect(() => {
    if (folders.length === 0) void loadFolders();
  }, [folders.length, loadFolders]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-9 shrink-0 items-center px-3 text-xs text-muted-foreground [-webkit-app-region:drag]">
        <div className="w-16 shrink-0" />
        <button
          type="button"
          onClick={() => setView("chat")}
          aria-label="Back to app"
          className="flex items-center gap-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} className="size-3.5" />
          <span>Back to app</span>
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <Rail section={section} onSelect={setSection} folders={folders} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-10 py-8">
          <div
            className={cn(
              "mx-auto flex w-full flex-col gap-10",
              section.kind === "pokedex" ? "max-w-5xl" : "max-w-2xl",
            )}
          >
            <SectionTitle section={section} folders={folders} />
            <Pane section={section} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Rail({
  section,
  onSelect,
  folders,
}: {
  section: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  folders: ReadonlyArray<Folder>;
}) {
  return (
    <nav className="flex w-56 shrink-0 flex-col gap-6 border-r border-border/40 bg-sidebar px-3 py-6 text-sm text-sidebar-foreground">
      <div className="flex flex-col gap-0.5">
        {VISIBLE_RAIL.map((item) => {
          const active =
            section.kind !== "repository" && section.kind === item.section.kind;
          return (
            <RailButton
              key={item.id}
              active={active}
              onClick={() => onSelect(item.section)}
              icon={item.Icon}
              label={item.label}
            />
          );
        })}
      </div>
      {folders.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-2">
            <span className="text-xs font-medium text-muted-foreground">
              Repositories
            </span>
            <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {folders.length}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {folders.map((f) => {
              const active =
                section.kind === "repository" && section.projectId === f.id;
              return (
                <RailButton
                  key={f.id}
                  active={active}
                  onClick={() =>
                    onSelect({ kind: "repository", projectId: f.id })
                  }
                  icon={Folder01Icon}
                  label={f.name}
                  title={f.path}
                  truncate
                />
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}

function RailButton({
  active,
  onClick,
  icon: Icon,
  label,
  title,
  truncate,
}: {
  active: boolean;
  onClick: () => void;
  icon: IconSvgElement;
  label: string;
  title?: string;
  truncate?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
      )}
    >
      <HugeiconsIcon icon={Icon} className="size-4 shrink-0" />
      <span className={cn(truncate && "truncate")}>{label}</span>
    </button>
  );
}

function SectionTitle({
  section,
  folders,
}: {
  section: SettingsSection;
  folders: ReadonlyArray<Folder>;
}) {
  const { title, subtitle } = useMemo(() => {
    if (section.kind === "general") {
      return {
        title: "General",
        subtitle: "Defaults for new chats and sub-agents.",
      };
    }
    if (section.kind === "providers") {
      return {
        title: "Providers",
        subtitle:
          "Verify what's installed, signed in, and which subscription each provider runs on.",
      };
    }
    if (section.kind === "workspace") {
      return {
        title: "Workspace",
        subtitle: "How new chats relate to your git checkout.",
      };
    }
    if (section.kind === "pokedex") {
      return {
        title: "Pokedex",
        subtitle: "Unlocked Pokémon from all worktrees.",
      };
    }
    if (section.kind === "browser") {
      return {
        title: "Browser",
        subtitle: "Dummy test logins the agent browser can autofill.",
      };
    }
    if (section.kind === "shortcuts") {
      return {
        title: "Keyboard shortcuts",
        subtitle: "These also appear under the menu bar.",
      };
    }
    if (section.kind === "developer") {
      return {
        title: "Developer",
        subtitle:
          "Accent palette + workflow chip/button states (dev builds only).",
      };
    }
    const f = folders.find((x) => x.id === section.projectId);
    return {
      title: f?.name ?? "Repository",
      subtitle: f?.path ?? "",
    };
  }, [section, folders]);
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      {subtitle && (
        <p
          className={cn(
            "text-sm text-muted-foreground",
            section.kind === "repository" && "truncate font-mono text-xs",
          )}
          title={section.kind === "repository" ? subtitle : undefined}
        >
          {subtitle}
        </p>
      )}
    </div>
  );
}

function Pane({ section }: { section: SettingsSection }) {
  if (section.kind === "general") return <GeneralPane />;
  if (section.kind === "providers") return <ProvidersPane />;
  if (section.kind === "workspace") return <WorkspacePane />;
  if (section.kind === "pokedex") return <PokedexPane />;
  if (section.kind === "browser") return <BrowserSettingsPane />;
  if (section.kind === "shortcuts") return <KeybindingsPane />;
  if (section.kind === "developer") return <DeveloperPane />;
  return <RepositorySettings projectId={section.projectId} />;
}

interface BrowserCredRow {
  readonly origin: string;
  readonly username: string;
}

/**
 * Browser settings — manage the DUMMY/TEST logins the agent browser autofills
 * via `browser_login`. Passwords go straight to the OS keychain (write-only
 * from here; the list RPC never returns them). The warning banner is
 * load-bearing: real credentials must never live here.
 */
function BrowserSettingsPane() {
  const [creds, setCreds] = useState<ReadonlyArray<BrowserCredRow>>([]);
  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const client = await getRpcClient();
    const list = await Effect.runPromise(client.browser.listCredentials({}));
    setCreds(list.map((c) => ({ origin: c.origin, username: c.username })));
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    if (origin.trim() === "" || password === "") return;
    setBusy(true);
    try {
      const client = await getRpcClient();
      await Effect.runPromise(
        client.browser.setCredential({
          origin: origin.trim(),
          username: username.trim(),
          password,
        }),
      );
      setOrigin("");
      setUsername("");
      setPassword("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    const client = await getRpcClient();
    await Effect.runPromise(
      client.browser.removeCredential({ origin: target }),
    );
    await load();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2.5 text-[12px] leading-relaxed text-amber-200">
        <HugeiconsIcon icon={Alert01Icon} className="mt-0.5 size-4 shrink-0" />
        <span>
          <strong className="font-semibold">Dummy / test logins only.</strong>{" "}
          Never store a real or production password here. These are for seeded
          accounts on dev and staging sites you ask the agent to verify. The
          agent never sees the password — it's injected straight into the page.
        </span>
      </div>

      <SettingsFrame
        title="Saved logins"
        description="The agent calls browser_login with a site's origin; you'll always be asked to approve before it submits."
      >
        <div className="flex flex-col gap-3">
          {creds.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No saved logins yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/40">
              {creds.map((c) => (
                <li
                  key={c.origin}
                  className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {c.origin}
                    </p>
                    <p className="truncate text-[12px] text-muted-foreground">
                      {c.username || "(no username)"} · ••••••••
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void remove(c.origin)}
                    aria-label={`Remove login for ${c.origin}`}
                    className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-2 border-t border-border/40 pt-3">
            <CredInput
              placeholder="Origin (https://app.example.com)"
              value={origin}
              onChange={setOrigin}
            />
            <CredInput
              placeholder="Username / email"
              value={username}
              onChange={setUsername}
            />
            <CredInput
              placeholder="Password (dummy)"
              value={password}
              onChange={setPassword}
              type="password"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => void add()}
                disabled={busy || origin.trim() === "" || password === ""}
              >
                <Plus className="size-3.5" strokeWidth={1.8} />
                Add login
              </Button>
            </div>
          </div>
        </div>
      </SettingsFrame>
    </div>
  );
}

function CredInput({
  placeholder,
  value,
  onChange,
  type = "text",
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "password";
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-border/50 bg-background px-3 py-1.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-border"
    />
  );
}

const BRANCH_STYLE_ORDER: ReadonlyArray<BranchNamingStyle> = [
  "username-slug",
  "slug",
  "feat-slug",
  "custom",
];

const BRANCH_STYLE_META: Record<
  BranchNamingStyle,
  { label: string; example: string }
> = {
  "username-slug": {
    label: "username/branch",
    example: "swarajbachu/dark-mode",
  },
  slug: { label: "branch only", example: "dark-mode" },
  "feat-slug": { label: "feat/branch", example: "feat/dark-mode" },
  custom: { label: "custom prefix", example: "prefix/dark-mode" },
};

function GeneralPane() {
  const defaultRuntimeMode = useSettingsStore((s) => s.defaultRuntimeMode);
  const setDefaultRuntimeMode = useSettingsStore(
    (s) => s.setDefaultRuntimeMode,
  );
  const completionSoundEnabled = useSettingsStore(
    (s) => s.completionSoundEnabled,
  );
  const setCompletionSoundEnabled = useSettingsStore(
    (s) => s.setCompletionSoundEnabled,
  );
  const completionSoundPreset = useSettingsStore(
    (s) => s.completionSoundPreset,
  );
  const setCompletionSoundPreset = useSettingsStore(
    (s) => s.setCompletionSoundPreset,
  );
  const branchNamingStyle = useSettingsStore((s) => s.branchNamingStyle);
  const setBranchNamingStyle = useSettingsStore((s) => s.setBranchNamingStyle);
  const branchNamingPrefix = useSettingsStore((s) => s.branchNamingPrefix);
  const setBranchNamingPrefix = useSettingsStore(
    (s) => s.setBranchNamingPrefix,
  );
  const setOnboardingCompleted = useSettingsStore(
    (s) => s.setOnboardingCompleted,
  );
  const setView = useUiStore((s) => s.setView);

  // Local mirror so typing is smooth; persist on blur to avoid an atomic
  // settings-file write per keystroke.
  const [prefixDraft, setPrefixDraft] = useState(branchNamingPrefix);
  useEffect(() => {
    setPrefixDraft(branchNamingPrefix);
  }, [branchNamingPrefix]);

  return (
    <div className="flex flex-col gap-4">
      <SettingsGroup
        title="Agent defaults"
        description="Defaults used when a new chat or background agent starts."
      >
        <SettingsRow
          title="Default permission mode"
          description="How the agent handles tool calls in new sessions. Each session can override this from its composer."
          action={
            <Select
              value={defaultRuntimeMode}
              onValueChange={(v) => setDefaultRuntimeMode(v as RuntimeMode)}
              items={MODES_ORDER.map((m) => ({
                label: MODE_META[m].label,
                value: m,
              }))}
            >
              <SelectTrigger size="sm" className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {MODES_ORDER.map((mode) => {
                  const m = MODE_META[mode];
                  return (
                    <SelectItem key={mode} value={mode}>
                      <div className="flex flex-col">
                        <span>{m.label}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {m.description}
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Agent completion sound"
          description="Play a short sound when any agent turn finishes, including agents working in background chats."
          action={
            <Switch
              checked={completionSoundEnabled}
              onCheckedChange={(value) => {
                setCompletionSoundEnabled(value);
                if (value) void prepareCompletionSound();
              }}
            />
          }
        >
          <div
            className={cn(
              "flex flex-wrap items-center gap-2",
              !completionSoundEnabled && "opacity-60",
            )}
          >
            <HugeiconsIcon
              icon={VolumeHighIcon}
              className="size-4 shrink-0 text-muted-foreground"
            />
            <Select
              value={completionSoundPreset}
              onValueChange={(v) =>
                setCompletionSoundPreset(v as CompletionSoundPreset)
              }
              items={COMPLETION_SOUND_PRESETS.map((preset) => ({
                label: preset.label,
                value: preset.value,
              }))}
            >
              <SelectTrigger
                size="sm"
                className="w-[160px]"
                disabled={!completionSoundEnabled}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {COMPLETION_SOUND_PRESETS.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              variant="settings"
              size="sm"
              disabled={!completionSoundEnabled}
              onClick={() => void playCompletionSound(completionSoundPreset)}
            >
              Preview
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Workspace naming"
        description="Controls how memoize names new worktree-backed branches."
      >
        <SettingsRow
          title="Branch naming"
          description="When a new chat with its own worktree gets its first message, memoize summarizes it and renames the chat plus its git branch in this shape."
          action={
            <Select
              value={branchNamingStyle}
              onValueChange={(v) =>
                setBranchNamingStyle(v as BranchNamingStyle)
              }
              items={BRANCH_STYLE_ORDER.map((s) => ({
                label: BRANCH_STYLE_META[s].label,
                value: s,
              }))}
            >
              <SelectTrigger size="sm" className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {BRANCH_STYLE_ORDER.map((style) => {
                  const m = BRANCH_STYLE_META[style];
                  return (
                    <SelectItem key={style} value={style}>
                      <div className="flex flex-col">
                        <span>{m.label}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {m.example}
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
          }
        >
          {branchNamingStyle === "custom" && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border/40 bg-background/60 p-3">
              <label className="text-xs font-medium text-muted-foreground">
                Custom prefix
              </label>
              <input
                type="text"
                value={prefixDraft}
                placeholder="e.g. swaraj or team/wip"
                spellCheck={false}
                onChange={(e) => setPrefixDraft(e.target.value)}
                onBlur={() => {
                  if (prefixDraft !== branchNamingPrefix) {
                    setBranchNamingPrefix(prefixDraft);
                  }
                }}
                className="h-8 w-full max-w-[260px] rounded-lg border border-border/50 bg-background px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-border"
              />
              <p className="text-xs leading-snug text-muted-foreground">
                Slash-joined before the slug. Letters, digits, slashes and
                dashes; leave empty for a bare slug.
              </p>
            </div>
          )}
        </SettingsRow>
      </SettingsGroup>

      <SubagentsSection />

      <SettingsGroup title="Setup">
        <SettingsRow
          title="Onboarding"
          description="Replay the first-launch welcome flow. Your existing projects and credentials stay put."
          action={
            <Button
              variant="settings"
              size="sm"
              onClick={() => {
                setView("chat");
                setOnboardingCompleted(false);
              }}
            >
              Show again
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  );
}

function ProvidersPane() {
  const availability = useProvidersStore((s) => s.availability);
  const loading = useProvidersStore((s) => s.loading);
  const error = useProvidersStore((s) => s.error);
  const refresh = useProvidersStore((s) => s.refresh);
  const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
  const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider);
  const providerEnabled = useSettingsStore((s) => s.providerEnabled);

  // Refresh once on mount + re-poll when the window regains focus so the
  // "Checked X ago" line reflects reality without forcing the user to hit
  // refresh themselves.
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const now = useRelativeTimeTick(15_000);
  const lastCheckedAt = useMemo(() => {
    let latest: Date | null = null;
    for (const a of availability) {
      const ts = a.lastCheckedAt;
      if (ts === undefined) continue;
      if (latest === null || ts.getTime() > latest.getTime()) latest = ts;
    }
    return latest;
  }, [availability]);

  const providers: ReadonlyArray<ProviderId> = [
    "claude",
    "codex",
    "grok",
    "gemini",
    "cursor",
    "opencode",
  ];
  const availabilityById = useMemo(() => {
    const map = new Map<ProviderId, (typeof availability)[number]>();
    for (const a of availability) map.set(a.providerId, a);
    return map;
  }, [availability]);

  const statusLabel = loading
    ? "Checking…"
    : error !== null
      ? `Probe failed · ${error}`
      : lastCheckedAt
        ? `Checked ${formatRelativeTime(lastCheckedAt, now) ?? "just now"}`
        : availability.length > 0
          ? "Checked"
          : "Not checked yet";

  return (
    <>
      <Frame>
        <FrameHeader className="flex flex-row items-center justify-between px-2 py-2 w-full">
          <p className="text-sm font-semibold text-foreground">
            Installed providers
          </p>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground/80">
              {statusLabel}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="Refresh provider status"
            >
              <HugeiconsIcon
                icon={RotateRight01Icon}
                className={cn("size-3.5", loading && "animate-spin")}
                aria-hidden
              />
            </Button>
          </div>
        </FrameHeader>
        <Card>
          <div className="flex flex-col divide-y divide-border/40">
            {providers.map((pid) => (
              <ProviderCard
                key={pid}
                providerId={pid}
                availability={availabilityById.get(pid)}
                loading={loading}
              />
            ))}
          </div>
        </Card>
        <FrameFooter className="px-2 py-1 w-full">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Memoize uses your existing CLI credentials — Claude Code, Codex,
            Grok, Gemini, Cursor, and OpenCode all sign in through their own
            login flows.
          </p>
        </FrameFooter>
      </Frame>

      <SettingsFrame
        title="Default agent"
        description="Which provider new chats start in. Change per session from the composer."
        flush
      >
        <div
          role="radiogroup"
          aria-label="Default agent"
          className="flex flex-col divide-y divide-border/40"
        >
          {providers
            .filter((pid) => {
              // Hide providers the user has toggled off. Cursor is still
              // excluded because it has an unconditional subscription gate.
              // Grok is allowed once the probe confirms a usable paid tier,
              // including X Premium+.
              if (providerEnabled[pid] === false) return false;
              if (pid === "cursor") return false;
              return true;
            })
            .map((pid) => {
              const selected = pid === defaultProviderId;
              return (
                <button
                  key={pid}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setDefaultProvider(pid)}
                  className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                >
                  <ProviderIcon providerId={pid} className="size-4 shrink-0" />
                  <span className="flex-1 truncate text-sm font-medium text-foreground">
                    {PROVIDER_LABEL[pid]}
                  </span>
                  <RadioCheck active={selected} />
                </button>
              );
            })}
        </div>
      </SettingsFrame>
    </>
  );
}

function WorkspacePane() {
  const defaultAutoCreateWorktree = useSettingsStore(
    (s) => s.defaultAutoCreateWorktree,
  );
  const setDefaultAutoCreateWorktree = useSettingsStore(
    (s) => s.setDefaultAutoCreateWorktree,
  );
  return (
    <SettingsFrame
      title="Auto-create worktree for new chats"
      trailing={
        <Switch
          checked={defaultAutoCreateWorktree}
          onCheckedChange={setDefaultAutoCreateWorktree}
        />
      }
      description="When on, each new chat runs in its own git worktree under ~/.memoize/<repo>/<name>/, branched off the project's HEAD. Per-repo settings can override this default."
    />
  );
}

/**
 * Sub-agents settings. Master toggle + per-preset toggle. Model dropdowns
 * read the user's overlay; a future "Edit" sheet will surface the prompt
 * + tool subset.
 */
function SubagentsSection() {
  const enableForNewSessions = useSubagentsStore((s) => s.enableForNewSessions);
  const setEnableForNewSessions = useSubagentsStore(
    (s) => s.setEnableForNewSessions,
  );
  const presets = useSubagentsStore((s) => s.presets);
  const setPresetEnabled = useSubagentsStore((s) => s.setPresetEnabled);
  const setPresetOverride = useSubagentsStore((s) => s.setPresetOverride);

  const claudeModels = MODELS_BY_PROVIDER.claude;

  return (
    <Frame>
      <FrameHeader className="flex flex-row items-center justify-between px-2 py-2 w-full">
        <p className="text-sm font-semibold text-foreground">Sub-agents</p>
        <Switch
          checked={enableForNewSessions}
          onCheckedChange={setEnableForNewSessions}
        />
      </FrameHeader>

      <Card
        className={cn(
          enableForNewSessions ? "" : "pointer-events-none opacity-50",
        )}
      >
        <div className="flex flex-col divide-y divide-border/40 overflow-hidden">
          {DEFAULT_SUBAGENT_PRESETS.map((preset) => {
            const ps = presets[preset.name] ?? {
              enabled: true,
              overrides: {},
            };
            const currentModel =
              ps.overrides.model ?? preset.definition.model ?? "";
            const rowDisabled = !enableForNewSessions || !ps.enabled;
            return (
              <div
                key={preset.name}
                className="flex flex-col gap-3 px-4 py-3.5"
              >
                <label className="group flex cursor-pointer items-start gap-3">
                  <Switch
                    checked={ps.enabled && enableForNewSessions}
                    disabled={!enableForNewSessions}
                    onCheckedChange={(v) => setPresetEnabled(preset.name, v)}
                    className="mt-0.5 shrink-0"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-semibold leading-none text-foreground">
                      {preset.displayName}
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {preset.summary}
                    </span>
                  </span>
                </label>

                <div
                  className={cn(
                    "ml-[calc(--spacing(9)+--spacing(3))] flex flex-col gap-2",
                    rowDisabled && "pointer-events-none opacity-50",
                  )}
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-semibold leading-none text-foreground">
                      Model
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      Pick which model handles this sub-agent's turns.
                    </span>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label={`Model for ${preset.displayName}`}
                    className="flex flex-col"
                  >
                    {claudeModels.map((m) => {
                      const selected = currentModel === m.id;
                      return (
                        <label
                          key={m.id}
                          className="group flex cursor-pointer items-center gap-3 py-1.5"
                        >
                          <input
                            type="radio"
                            name={`subagent-model-${preset.name}`}
                            value={m.id}
                            checked={selected}
                            onChange={() =>
                              setPresetOverride(preset.name, { model: m.id })
                            }
                            className="sr-only"
                          />
                          <RadioCheck active={selected} />
                          <span className="text-sm text-foreground">
                            {m.label}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <FrameFooter className="px-2 py-1 w-full">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Let your main agent delegate scoped tasks to cheaper models. Saves
          tokens on long sessions.
        </p>
      </FrameFooter>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/**
 * Frame-shaped settings block: outer muted shell with `FrameHeader` (title
 * + optional trailing action), optional inner `Card` body, and
 * `FrameFooter` for the description. Use for every settings group that
 * fits the "title • body • description" shape — sub-agents-style.
 */
export function SettingsFrame({
  title,
  trailing,
  description,
  bodyClassName,
  flush,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  description?: React.ReactNode;
  bodyClassName?: string;
  /** When true, render children flush inside the Card without inner padding. */
  flush?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Frame>
      <FrameHeader className="flex flex-row items-center justify-between px-2 py-2 w-full">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {trailing}
      </FrameHeader>
      {children && (
        <Card className={bodyClassName}>
          {flush ? children : <div className="px-4 py-3">{children}</div>}
        </Card>
      )}
      {description && (
        <FrameFooter className="px-2 py-1 w-full">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </FrameFooter>
      )}
    </Frame>
  );
}

/**
 * Grouped settings section: muted outer frame, compact header, one inner
 * card split into rows. Use when several related settings should read as a
 * single decision area instead of separate cards.
 */
export function SettingsGroup({
  title,
  description,
  trailing,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Frame>
      <FrameHeader className="flex flex-row items-start justify-between gap-3 px-2 py-2 w-full">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {trailing && <div className="shrink-0 pt-0.5">{trailing}</div>}
      </FrameHeader>
      <Card className="overflow-hidden">
        <div className="flex flex-col divide-y divide-border/40">
          {children}
        </div>
      </Card>
    </Frame>
  );
}

/**
 * Single-surface container for a group of settings rows. Renders one
 * rounded panel with a subtle muted background — no inner card, no double
 * nesting. Pair with `SettingsRow` for the row layout.
 */
export function SettingsCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-muted/30",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Compact uppercase header bar for a `SettingsCard`. Single line, optional
 * leading icon, optional trailing slot (status text, refresh button,
 * toggle). Renders above the rest of the card content with a bottom
 * divider courtesy of the parent's `divide-y`.
 */
export function SettingsCardHeader({
  icon: Icon,
  title,
  trailing,
}: {
  icon?: IconSvgElement;
  title: string;
  trailing?: React.ReactNode;
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 px-4 text-muted-foreground">
      {Icon && <HugeiconsIcon icon={Icon} className="size-3.5" aria-hidden />}
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
        {title}
      </span>
      {trailing && (
        <div className="flex shrink-0 items-center gap-2">{trailing}</div>
      )}
    </header>
  );
}

/**
 * Settings row: title + (optional) description on the left, action on the
 * right. When `children` are passed instead of `action`, they render under
 * the title/description (for cases like radio-group pickers).
 */
export function SettingsRow({
  icon: Icon,
  title,
  description,
  action,
  className,
  children,
}: {
  icon?: IconSvgElement;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-3 px-4 py-3.5", className)}>
      <div className="flex items-start gap-3">
        {Icon && (
          <HugeiconsIcon
            icon={Icon}
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && (
            <div className="text-xs leading-snug text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {action && <div className="shrink-0 pt-0.5">{action}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * Legacy `Section` helper kept for back-compat with call-sites that
 * haven't been migrated to `SettingsCard` + `SettingsRow`. New code should
 * prefer those primitives.
 */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <SettingsCard>
      <SettingsRow title={title} description={description}>
        {children}
      </SettingsRow>
    </SettingsCard>
  );
}

export function OptionGroup({
  children,
  columns,
}: {
  children: React.ReactNode;
  columns?: 2 | 3;
}) {
  return (
    <div
      role="radiogroup"
      className={cn(
        "gap-2",
        columns === 2 && "grid grid-cols-2",
        columns === 3 && "grid grid-cols-3",
        !columns && "flex flex-col",
      )}
    >
      {children}
    </div>
  );
}

export function OptionCard({
  icon: Icon,
  iconNode,
  title,
  description,
  active,
  onClick,
  disabled,
}: {
  icon?: IconSvgElement;
  iconNode?: React.ReactNode;
  title: string;
  description?: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const compact = !description;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        compact ? "px-3 py-2" : "items-start px-3.5 py-3",
        active
          ? "border-foreground/30 bg-accent/40"
          : "border-border/50 hover:bg-muted/40",
      )}
    >
      <RadioDot active={active} className={compact ? "" : "mt-0.5"} />
      {(Icon || iconNode) && (
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center text-muted-foreground group-aria-checked:text-foreground",
            !compact && "mt-0.5",
          )}
        >
          {iconNode ??
            (Icon ? <HugeiconsIcon icon={Icon} className="size-4" /> : null)}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium leading-none text-foreground">
          {title}
        </span>
        {description && (
          <span className="text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </button>
  );
}

function RadioDot({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        active
          ? "border-foreground bg-background"
          : "border-border bg-background group-hover:border-foreground/60",
        className,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-foreground transition-transform duration-150",
          active ? "scale-100" : "scale-0",
        )}
      />
    </span>
  );
}

/**
 * Cleaner radio rendering: filled solid disc with checkmark when selected,
 * hollow bordered circle when not. No inner-dot pattern.
 */
export function RadioCheck({
  active,
  className,
}: {
  active: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        active
          ? "border-primary bg-primary"
          : "border-border bg-background group-hover:border-foreground/60",
        className,
      )}
    >
      {active && (
        <HugeiconsIcon
          icon={Tick01Icon}
          className="size-2.5 text-primary-foreground"
          strokeWidth={3.5}
          aria-hidden
        />
      )}
    </span>
  );
}

export function CheckboxField({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "group/checkbox flex items-start gap-3 rounded-lg border border-border/50 px-3.5 py-3 text-sm transition-colors hover:bg-muted/40 has-[:focus-visible]:border-foreground/30 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <CheckboxInput
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5"
      />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="font-medium leading-none text-foreground">
          {label}
        </span>
        {description && (
          <span className="text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

/**
 * Visually-styled checkbox: native `<input>` is `sr-only` for accessibility
 * and form semantics, custom box is rendered as a sibling so we get
 * `peer-focus-visible` rings + a real checkmark on solid-foreground fill.
 */
export function CheckboxInput({
  checked,
  onChange,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 size-4 cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className={cn(
          "flex size-4 items-center justify-center rounded-[5px] border transition-colors",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
          checked
            ? "border-foreground bg-foreground"
            : "border-border bg-background peer-hover:border-foreground/60",
          disabled && "opacity-50",
        )}
      >
        {checked && (
          <HugeiconsIcon
            icon={Tick01Icon}
            className="size-3 text-background"
            strokeWidth={3.5}
            aria-hidden
          />
        )}
      </span>
    </span>
  );
}

/**
 * "Inherits global ↔ Custom" segmented control for per-repo overrides.
 * When inheriting, the children dim and clicks bypass. Picking any option
 * inside `children` flips back to "Custom".
 */
export function OverrideField({
  isOverridden,
  globalLabel,
  onClear,
  children,
}: {
  isOverridden: boolean;
  globalLabel: string;
  onClear: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-md border border-border/50 bg-muted p-0.5 text-xs">
          <button
            type="button"
            onClick={onClear}
            className={cn(
              "rounded px-2.5 py-1 transition-colors",
              !isOverridden
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Inherit
          </button>
          <button
            type="button"
            disabled={isOverridden}
            className={cn(
              "rounded px-2.5 py-1 transition-colors",
              isOverridden
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
            )}
          >
            Custom
          </button>
        </div>
        {!isOverridden && (
          <span className="truncate text-xs text-muted-foreground">
            {globalLabel}
          </span>
        )}
      </div>
      <div
        className={cn(
          "transition-opacity",
          isOverridden ? "" : "pointer-events-none opacity-50",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function ModelSelect({
  providerId,
  value,
  onChange,
}: {
  providerId: ProviderId;
  value: string | null;
  onChange: (model: string) => void;
}) {
  const models = MODELS_BY_PROVIDER[providerId] ?? [];
  const normalizedValue =
    value !== null &&
    (models.some((m) => m.id === value) || models.length === 0)
      ? (value ?? "")
      : (models[0]?.id ?? "");
  const items = useMemo(
    () => models.map((m) => ({ value: m.id, label: m.label })),
    [models],
  );
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        Default model
      </span>
      <Select
        value={normalizedValue}
        onValueChange={(next) => onChange(next as string)}
        items={items}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

// Re-exported helpers consumed by `ChatComposer`'s "ensure valid defaults"
// path that picks an effective provider/model when the user's saved
// default isn't currently logged in.
export function ensureValidDefaultsForRuntime(
  ready: ReadonlyArray<ProviderId>,
): { providerId: ProviderId; model: string; runtimeMode: RuntimeMode } | null {
  const settings = useSettingsStore.getState();
  if (ready.length === 0) return null;
  const provider = ready.includes(settings.defaultProviderId)
    ? settings.defaultProviderId
    : ready[0]!;
  const model =
    settings.defaultModelByProvider[provider] ??
    MODELS_BY_PROVIDER[provider][0]!.id;
  return {
    providerId: provider,
    model,
    runtimeMode: settings.defaultRuntimeMode,
  };
}

export { PROVIDER_LABEL };
export type { FolderId };
