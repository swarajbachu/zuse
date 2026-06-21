import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Search01Icon,
  Tick01Icon,
} from "@hugeicons-pro/core-bulk-rounded";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  AgentAvailability,
  ChatId,
  ProviderId,
  RuntimeMode,
  SessionId,
} from "@memoize/wire";
import {
  MODELS_BY_PROVIDER,
  findModelDescriptor,
  type Message,
  type SelectOptionDescriptor,
} from "@memoize/wire";

import { cn } from "~/lib/utils";
import { useMessagesStore } from "~/store/messages";
import { useOpencodeInventory } from "~/store/opencode-inventory";
import { useProvidersStore } from "~/store/providers";
import { useSessionsStore } from "~/store/sessions";
import { useSettingsStore } from "~/store/settings";
import { ProviderIcon } from "./provider-icons";
import { Popover, PopoverPrimitive, PopoverTrigger } from "./ui/popover";
import {
  pushModelPickerEvent,
  readModelPickerEvents,
  topRecents,
  type ModelPickerEvent,
  type ModelPickerRecent,
} from "~/lib/model-picker-recents";

const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  gemini: "Gemini",
  opencode: "OpenCode",
};

const PROVIDER_CHIP_LABEL: Record<ProviderId, string> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  gemini: "gemini",
  opencode: "oc",
};

interface ModelPickerEntry {
  providerId: ProviderId;
  modelId: string;
  label: string;
  /**
   * When set, render a small context-window pill on this row. We only show
   * a pill when the model's `contextWindow` descriptor defaults to `"1m"`
   * — otherwise the chip would clutter every legacy 200k row.
   */
  contextWindowLabel?: string;
}

type Scope = ProviderId | "all";

type ModelPickerProps =
  | {
      mode: "session";
      sessionId: SessionId;
      chatId: ChatId;
      runtimeMode: RuntimeMode;
      providerId: ProviderId;
      currentModel: string;
      onOpenChange?: (open: boolean) => void;
    }
  | {
      mode: "default";
      onOpenChange?: (open: boolean) => void;
    };

export function ModelPicker(props: ModelPickerProps) {
  const isDefault = props.mode === "default";

  // Live values
  const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
  const defaultModelByProvider = useSettingsStore(
    (s) => s.defaultModelByProvider,
  );
  const providerEnabled = useSettingsStore((s) => s.providerEnabled);

  const providerId = isDefault ? defaultProviderId : props.providerId;
  const currentModel = isDefault
    ? defaultModelByProvider[providerId]
    : props.currentModel;

  // Setters
  const setSessionModel = useSessionsStore((s) => s.setModel);
  const setSessionProvider = useSessionsStore((s) => s.setProvider);
  const createSession = useSessionsStore((s) => s.create);
  const setDefaultProviderAndModel = useSettingsStore(
    (s) => s.setDefaultProviderAndModel,
  );

  const availability = useProvidersStore((s) => s.availability);
  const opencodeInventory = useOpencodeInventory((s) => s.inventory);
  const ensureOpencodeInventory = useOpencodeInventory((s) => s.ensureLoaded);

  const userMessageCount = useMessagesStore((s) => {
    if (isDefault) return 0;
    const sid = (props as any).sessionId as SessionId;
    const list = s.messagesBySession[sid] ?? [];
    let count = 0;
    for (const m of list) {
      if ((m as Message).role === "user") count += 1;
    }
    return count;
  });
  const isFresh = isDefault ? true : userMessageCount === 0;

  useEffect(() => {
    void ensureOpencodeInventory();
  }, [ensureOpencodeInventory]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [events, setEvents] = useState<ModelPickerEvent[]>([]);
  const [expandedGroup, setExpandedGroup] = useState<ProviderId | null>(
    providerId,
  );
  // Inline feedback for failed picks. The session-mode handlers
  // (createSession / setSessionProvider / setSessionModel) used to fire-
  // and-forget, so a failed switch (cursor-agent not installed, ACP
  // handshake timeout, etc.) just closed the popover with no clue why.
  // We now await them and surface the reason here.
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Forward open state to parent so ChatComposer can block Enter submit
  const onOpenChange = props.onOpenChange;
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // Reset transient state every time the popover opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setEvents(readModelPickerEvents());
      setScope("all");
      setExpandedGroup(providerId);
      setPickError(null);
      setPicking(false);
    }
  }, [open, providerId]);

  const modelsForProvider = useCallback(
    (pid: ProviderId): ReadonlyArray<{ id: string; label: string }> => {
      if (pid !== "opencode" || opencodeInventory === null) {
        return MODELS_BY_PROVIDER[pid] ?? [];
      }
      return opencodeInventory.providers.flatMap((p) =>
        p.models.map((m) => ({ id: m.id, label: m.label })),
      );
    },
    [opencodeInventory],
  );

  const availabilityById = useMemo(() => {
    const m = new globalThis.Map<ProviderId, AgentAvailability>();
    for (const a of availability) m.set(a.providerId, a);
    return m;
  }, [availability]);

  const pickableProviders = useMemo<ReadonlyArray<ProviderId>>(() => {
    return (
      Object.keys(MODELS_BY_PROVIDER) as ReadonlyArray<ProviderId>
    ).filter((pid) => {
      if (pid === providerId) return true;
      if (providerEnabled[pid] === false) return false;
      const a = availabilityById.get(pid);
      return a?.status !== "error";
    });
  }, [providerId, providerEnabled, availabilityById]);

  const allModels = useMemo<ModelPickerEntry[]>(() => {
    const out: ModelPickerEntry[] = [];
    for (const pid of pickableProviders) {
      for (const m of modelsForProvider(pid)) {
        const descriptor = findModelDescriptor(pid, m.id);
        const ctxDescriptor = descriptor?.optionDescriptors?.find(
          (d): d is SelectOptionDescriptor =>
            d.kind === "select" && d.id === "contextWindow",
        );
        const ctxDefault = ctxDescriptor?.defaultId;
        const ctxLabel =
          ctxDescriptor !== undefined
            ? ctxDescriptor.options.find((o) => o.id === ctxDefault)?.label
            : undefined;
        // Only surface a pill when the default is the larger window —
        // 200k-by-default rows would be noise.
        const contextWindowLabel =
          ctxDefault === "1m" ? (ctxLabel ?? "1M") : undefined;
        out.push({
          providerId: pid,
          modelId: m.id,
          label: m.label,
          ...(contextWindowLabel !== undefined ? { contextWindowLabel } : {}),
        });
      }
    }
    return out;
  }, [pickableProviders, modelsForProvider]);

  const countByProvider = useMemo(() => {
    const map = new globalThis.Map<ProviderId, number>();
    for (const m of allModels) {
      map.set(m.providerId, (map.get(m.providerId) ?? 0) + 1);
    }
    return map;
  }, [allModels]);
  const totalCount = allModels.length;

  const flatMatches = useMemo<ModelPickerEntry[]>(() => {
    const q = query.trim().toLowerCase();
    return allModels.filter((m) => {
      if (scope !== "all" && m.providerId !== scope) return false;
      if (q === "") return true;
      return (
        m.label.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q)
      );
    });
  }, [allModels, scope, query]);

  const scopedRecents = useMemo<
    Array<ModelPickerEntry & { count: number }>
  >(() => {
    const top: ModelPickerRecent[] = topRecents(events, scope, 4);
    const out: Array<ModelPickerEntry & { count: number }> = [];
    for (const r of top) {
      const match = allModels.find(
        (m) => m.providerId === r.providerId && m.modelId === r.modelId,
      );
      if (match === undefined) continue;
      out.push({ ...match, count: r.count });
    }
    return out;
  }, [events, scope, allModels]);

  const accordionGroups = useMemo(() => {
    if (scope !== "all" || query.trim() !== "") return [];
    const order: ProviderId[] = [
      providerId,
      ...pickableProviders.filter((p) => p !== providerId),
    ];
    return order
      .map((pid) => ({
        providerId: pid,
        models: allModels.filter((m) => m.providerId === pid),
      }))
      .filter((g) => g.models.length > 0);
  }, [scope, query, allModels, pickableProviders, providerId]);

  const handlePick = async (pid: ProviderId, modelId: string) => {
    if (isDefault) {
      setDefaultProviderAndModel(pid, modelId);
      pushModelPickerEvent({ providerId: pid, modelId });
      setOpen(false);
      return;
    }

    const sessionId = (props as any).sessionId as SessionId;
    const chatId = (props as any).chatId as ChatId | undefined;
    const runtimeMode = (props as any).runtimeMode as RuntimeMode | undefined;

    const isCross = pid !== providerId;
    // Await whatever store call we kick off so we can keep the popover
    // open + show the reason if it fails. Previously these were `void`-d
    // and the popover always closed, swallowing SessionStartError from
    // a missing/broken CLI behind a silent close.
    setPickError(null);
    setPicking(true);
    try {
      if (isCross && !isFresh && chatId !== undefined) {
        const newId = await createSession(chatId, pid, modelId, {
          runtimeMode,
        });
        if (newId === null) {
          const reason =
            useSessionsStore.getState().error ??
            `Couldn't start ${pid}. Check that its CLI is installed and signed in.`;
          setPickError(reason);
          return;
        }
      } else if (isCross) {
        const result = await setSessionProvider(sessionId, pid, modelId);
        if (!result.ok) {
          setPickError(result.reason);
          return;
        }
      } else if (modelId !== currentModel) {
        await setSessionModel(sessionId, modelId);
        const reason = useSessionsStore.getState().error;
        if (reason !== null) {
          setPickError(reason);
          return;
        }
      }
      pushModelPickerEvent({ providerId: pid, modelId });
      setOpen(false);
    } finally {
      setPicking(false);
    }
  };

  const currentLabel =
    modelsForProvider(providerId).find((m) => m.id === currentModel)?.label ??
    currentModel;

  const showEmpty =
    flatMatches.length === 0 &&
    scopedRecents.length === 0 &&
    accordionGroups.length === 0;

  const inAccordionView = scope === "all" && query.trim() === "";

  const shortcutTargets = useMemo<ModelPickerEntry[]>(() => {
    const out: ModelPickerEntry[] = [];
    for (const r of scopedRecents) {
      out.push({
        providerId: r.providerId,
        modelId: r.modelId,
        label: r.label,
      });
    }
    if (inAccordionView) {
      const group = accordionGroups.find((g) => g.providerId === expandedGroup);
      if (group !== undefined) out.push(...group.models);
    } else {
      out.push(...flatMatches);
    }
    return out;
  }, [
    scopedRecents,
    inAccordionView,
    accordionGroups,
    expandedGroup,
    flatMatches,
  ]);

  // STABLE REFS — this is the fix so shortcuts actually work while the
  // composer editor is focused and causing re-renders.
  const shortcutTargetsRef = useRef(shortcutTargets);
  const handlePickRef = useRef(handlePick);
  useEffect(() => {
    shortcutTargetsRef.current = shortcutTargets;
  }, [shortcutTargets]);
  useEffect(() => {
    handlePickRef.current = handlePick;
  }, [handlePick]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.altKey || e.shiftKey) return;
      if (e.key < "1" || e.key > "9") return;
      const idx = Number(e.key) - 1;
      const target = shortcutTargetsRef.current[idx];
      if (target === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      void handlePickRef.current(target.providerId, target.modelId);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const shortcutFor = (pid: ProviderId, modelId: string): number | null => {
    const i = shortcutTargets.findIndex(
      (t) => t.providerId === pid && t.modelId === modelId,
    );
    if (i < 0 || i >= 9) return null;
    return i + 1;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-foreground hover:bg-muted/60 data-[popup-open]:bg-muted/60"
        aria-label="Change model"
        title="Change model — applies to next message"
      >
        <ProviderIcon providerId={providerId} className="size-3" />
        <span>{currentLabel}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="start"
          side="top"
          sideOffset={6}
          className="z-50"
        >
          <PopoverPrimitive.Popup
            ref={popupRef}
            className="flex max-h-[480px] w-[320px] flex-col overflow-hidden rounded-lg border border-border/70 bg-popover text-popover-foreground shadow-lg/10 outline-none"
          >
            <div className="flex flex-col gap-1.5 p-2.5">
              <SearchField
                value={query}
                onChange={setQuery}
                totalCount={totalCount}
                scope={scope}
              />
              <div className="flex flex-wrap gap-1 px-0.5 pt-1">
                <ChipButton
                  active={scope === "all"}
                  onClick={() => setScope("all")}
                >
                  <span>all</span>
                  <ChipCount>{totalCount}</ChipCount>
                </ChipButton>
                {pickableProviders.map((pid) => {
                  const live = pid === "opencode" && opencodeInventory !== null;
                  return (
                    <ChipButton
                      key={pid}
                      active={scope === pid}
                      onClick={() => setScope(pid)}
                    >
                      <span>{PROVIDER_CHIP_LABEL[pid]}</span>
                      <ChipCount>{countByProvider.get(pid) ?? 0}</ChipCount>
                      {live && (
                        <span
                          className="size-1.5 rounded-full bg-primary"
                          title="Live from local daemon"
                        />
                      )}
                    </ChipButton>
                  );
                })}
              </div>
            </div>

            {pickError !== null && (
              <div className="mx-2.5 mb-1.5 flex items-start gap-2 rounded-md border border-rose-400/30 bg-rose-500/[0.08] px-2.5 py-2 text-[11px] text-rose-200">
                <span className="mt-px shrink-0">⚠</span>
                <span className="leading-snug">{pickError}</span>
              </div>
            )}

            <div
              className={cn(
                "flex-1 overflow-y-auto px-2 pb-2",
                picking && "pointer-events-none opacity-60",
              )}
            >
              {showEmpty && (
                <div className="px-3 py-6 text-center text-muted-foreground text-xs">
                  No models match.
                </div>
              )}

              {scopedRecents.length > 0 && (
                <>
                  <SectionLabel
                    title={
                      scope === "all"
                        ? "recents"
                        : `recents in ${PROVIDER_CHIP_LABEL[scope]}`
                    }
                    meta="last 30 days"
                  />
                  {scopedRecents.map((m) => (
                    <ModelRow
                      key={`recent-${m.providerId}-${m.modelId}`}
                      entry={m}
                      currentProviderId={providerId}
                      currentModelId={currentModel}
                      isFresh={isFresh}
                      onSelect={handlePick}
                      countSuffix={`${m.count}×`}
                      showNowBadge
                      shortcut={shortcutFor(m.providerId, m.modelId)}
                    />
                  ))}
                </>
              )}

              {inAccordionView ? (
                <>
                  <SectionLabel title={`all ${totalCount} by provider`} />
                  {accordionGroups.map((g) => {
                    const expanded = expandedGroup === g.providerId;
                    return (
                      <div key={g.providerId}>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedGroup(expanded ? null : g.providerId)
                          }
                          aria-expanded={expanded}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
                        >
                          <span className="flex size-3 items-center justify-center text-muted-foreground">
                            {expanded ? (
                              <HugeiconsIcon
                                icon={ArrowDown01Icon}
                                className="size-3"
                              />
                            ) : (
                              <HugeiconsIcon
                                icon={ArrowRight01Icon}
                                className="size-3"
                              />
                            )}
                          </span>
                          <ProviderIcon
                            providerId={g.providerId}
                            className="size-3.5"
                          />
                          <span className="flex-1 font-medium">
                            {PROVIDER_LABEL[g.providerId]}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {g.models.length}
                          </span>
                        </button>
                        {expanded && (
                          <div className="ml-3 border-l border-border/60 pl-2">
                            {g.models.map((m) => (
                              <ModelRow
                                key={`${m.providerId}-${m.modelId}`}
                                entry={m}
                                currentProviderId={providerId}
                                currentModelId={currentModel}
                                isFresh={isFresh}
                                onSelect={handlePick}
                                dense
                                shortcut={shortcutFor(m.providerId, m.modelId)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              ) : (
                flatMatches.length > 0 && (
                  <>
                    <SectionLabel
                      title={
                        scope === "all"
                          ? `${flatMatches.length} match${flatMatches.length === 1 ? "" : "es"}`
                          : `all ${flatMatches.length} models`
                      }
                    />
                    {flatMatches.map((m) => (
                      <ModelRow
                        key={`${m.providerId}-${m.modelId}`}
                        entry={m}
                        currentProviderId={providerId}
                        currentModelId={currentModel}
                        isFresh={isFresh}
                        onSelect={handlePick}
                        shortcut={shortcutFor(m.providerId, m.modelId)}
                      />
                    ))}
                  </>
                )
              )}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}

function SearchField({
  value,
  onChange,
  totalCount,
  scope,
}: {
  value: string;
  onChange: (next: string) => void;
  totalCount: number;
  scope: Scope;
}) {
  const placeholder =
    scope === "all"
      ? `filter ${totalCount} models…`
      : `in ${PROVIDER_CHIP_LABEL[scope]}…`;
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 focus-within:border-foreground/60 focus-within:ring-2 focus-within:ring-primary/30">
      <HugeiconsIcon
        icon={Search01Icon}
        className="size-3.5 text-muted-foreground"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus
        className="flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground/70"
      />
    </div>
  );
}

function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-foreground hover:bg-muted/60",
      )}
    >
      {children}
    </button>
  );
}

function ChipCount({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] opacity-60 tabular-nums">{children}</span>
  );
}

function SectionLabel({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex items-baseline justify-between px-2 pt-3 pb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
      <span>{title}</span>
      {meta !== undefined && (
        <span className="text-[9px] text-muted-foreground/70 normal-case tracking-normal">
          {meta}
        </span>
      )}
    </div>
  );
}

function ModelRow({
  entry,
  currentProviderId,
  currentModelId,
  isFresh,
  onSelect,
  dense = false,
  countSuffix,
  showNowBadge = false,
  shortcut,
}: {
  entry: ModelPickerEntry;
  currentProviderId: ProviderId;
  currentModelId: string;
  isFresh: boolean;
  onSelect: (providerId: ProviderId, modelId: string) => void;
  dense?: boolean;
  countSuffix?: string;
  showNowBadge?: boolean;
  shortcut?: number | null;
}) {
  const isActive =
    entry.providerId === currentProviderId && entry.modelId === currentModelId;
  const isCross = entry.providerId !== currentProviderId;
  const opensNewTab = isCross && !isFresh;
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.providerId, entry.modelId)}
      aria-current={isActive || undefined}
      title={opensNewTab ? "Open in new tab" : undefined}
      className={cn(
        "group relative flex w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
        dense ? "py-1" : "py-1.5",
        isActive
          ? "bg-primary/12 text-foreground"
          : "text-foreground hover:bg-muted/60",
      )}
    >
      {isActive && (
        <span className="-translate-y-1/2 absolute top-1/2 left-0 h-4 w-0.5 rounded-full bg-primary" />
      )}
      {!dense && (
        <ProviderIcon
          providerId={entry.providerId}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <span className="truncate">{entry.label}</span>
      {entry.contextWindowLabel !== undefined && (
        <span
          title={`${entry.contextWindowLabel} context window`}
          className="rounded bg-muted/70 px-1 py-px text-[10px] font-medium text-muted-foreground"
        >
          {entry.contextWindowLabel}
        </span>
      )}
      <span className="flex-1" />
      {opensNewTab && (
        <HugeiconsIcon
          icon={ArrowUpRight01Icon}
          className="size-3 text-muted-foreground/70"
          aria-label="Open in new tab"
        />
      )}
      {countSuffix !== undefined && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {countSuffix}
        </span>
      )}
      {showNowBadge && isActive && (
        <span className="rounded bg-primary px-1.5 py-px font-medium text-[9px] text-primary-foreground uppercase tracking-wider">
          now
        </span>
      )}
      {shortcut !== undefined && shortcut !== null && (
        <kbd className="ml-0.5 rounded bg-muted/70 px-1 py-px font-medium text-[10px] text-muted-foreground tabular-nums">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}
