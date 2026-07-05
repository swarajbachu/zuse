import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  PlugSocketIcon,
  RefreshIcon,
  Search01Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import { Effect } from "effect";
import { useEffect, useMemo, useState } from "react";

import type { OpencodeInventoryProvider } from "@zuse/wire";

import { getRpcClient } from "~/lib/rpc-client";
import { cn } from "~/lib/utils";
import { useOpencodeInventory } from "~/store/opencode-inventory";
import { useSettingsStore } from "~/store/settings";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { ShimmerText } from "~/components/ui/shimmer-text";

/**
 * OpenCode is a meta-harness fronting ~150 model providers (models.dev) plus
 * any OpenAI-compatible endpoint the user brings. This panel replaces the
 * generic model-default / api-key block on the OpenCode provider card:
 *
 *  - **Providers** — connect a catalog provider by pasting its API key, or
 *    define a custom OpenAI-compatible one from a base URL. Keys are written
 *    through to opencode's own `auth.json` (via `agent.opencodeSetProviderAuth`
 *    / `agent.opencodeAddCustomProvider`) so they also work in a terminal.
 *  - **Models** — pick which connected providers' models show in the picker.
 *  - **Advanced** — default model + per-provider picker visibility.
 *
 * The catalog + connected state comes from `useOpencodeInventory`
 * (`provider.list()` behind a short-lived `opencode serve`); visibility state
 * lives in settings.json.
 */
export function OpencodeProviderManager() {
  const inventory = useOpencodeInventory((s) => s.inventory);
  const invLoading = useOpencodeInventory((s) => s.loading);
  const ensureLoaded = useOpencodeInventory((s) => s.ensureLoaded);
  const refreshInventory = useOpencodeInventory((s) => s.refresh);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  const providers = useMemo(() => inventory?.providers ?? [], [inventory]);
  const connected = useMemo(
    () => providers.filter((p) => p.connected),
    [providers],
  );

  return (
    <div className="flex flex-col gap-4">
      <ProvidersSection
        providers={providers}
        connected={connected}
        loading={invLoading}
        onRefresh={() => void refreshInventory()}
      />
      {connected.length > 0 && <ModelsSection connected={connected} />}
      {connected.length > 0 && <AdvancedSection connected={connected} />}
    </div>
  );
}

/** Fire an opencode provider-management RPC, then refresh the inventory. */
const runOpencodeMutation = async (
  fn: (client: Awaited<ReturnType<typeof getRpcClient>>) => Promise<unknown>,
): Promise<void> => {
  const client = await getRpcClient();
  await fn(client);
};

/* ────────────────────────────── Providers ────────────────────────────── */

function ProvidersSection({
  providers,
  connected,
  loading,
  onRefresh,
}: {
  providers: ReadonlyArray<OpencodeInventoryProvider>;
  connected: ReadonlyArray<OpencodeInventoryProvider>;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            Providers
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            {connected.length} configured
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh providers"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            className={cn("size-3.5", loading && "animate-spin")}
            aria-hidden
          />
        </Button>
      </div>

      {connected.length === 0 ? (
        <ProviderCatalogDialog
          providers={providers}
          onChanged={onRefresh}
          trigger={
            <Button size="sm" variant="default" className="self-start">
              Add your first provider
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border/50 bg-background/45">
          {connected.map((p) => (
            <ConnectedProviderRow
              key={p.id}
              provider={p}
              onChanged={onRefresh}
            />
          ))}
        </div>
      )}

      {connected.length > 0 && (
        <div className="flex items-center gap-2">
          <ProviderCatalogDialog
            providers={providers}
            onChanged={onRefresh}
            trigger={
              <Button size="xs" variant="outline">
                <HugeiconsIcon
                  icon={Add01Icon}
                  className="mr-1 size-3"
                  aria-hidden
                />
                Add provider
              </Button>
            }
          />
          <CustomProviderDialog
            onChanged={onRefresh}
            trigger={
              <Button size="xs" variant="ghost">
                <HugeiconsIcon
                  icon={PlugSocketIcon}
                  className="mr-1 size-3"
                  aria-hidden
                />
                Add custom provider
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}

function ConnectedProviderRow({
  provider,
  onChanged,
}: {
  provider: OpencodeInventoryProvider;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await runOpencodeMutation((client) =>
        provider.custom
          ? Effect.runPromise(
              client.agent.opencodeRemoveCustomProvider({ id: provider.id }),
            )
          : Effect.runPromise(
              client.agent.opencodeRemoveProviderAuth({
                providerId: provider.id,
              }),
            ),
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-10 items-center gap-2 border-b border-border/40 px-2.5 py-1.5 last:border-b-0">
      <HugeiconsIcon
        icon={CheckmarkCircle02Icon}
        className="size-3.5 shrink-0 text-emerald-400"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-foreground">
          {provider.name}
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          {provider.custom ? "Custom · " : ""}
          {provider.models.length} model
          {provider.models.length === 1 ? "" : "s"}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => void remove()}
        disabled={busy}
        aria-label={`Remove ${provider.name}`}
        title="Remove credential"
      >
        <HugeiconsIcon icon={Delete02Icon} className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

/* ─────────────────────────── Catalog dialog ──────────────────────────── */

function ProviderCatalogDialog({
  providers,
  onChanged,
  trigger,
}: {
  providers: ReadonlyArray<OpencodeInventoryProvider>;
  onChanged: () => void;
  trigger: React.ReactElement;
}) {
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list =
      q.length === 0
        ? providers
        : providers.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.id.toLowerCase().includes(q),
          );
    // Connected first (already sorted server-side, re-apply after filter).
    return [...list].sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [providers, query]);

  return (
    <Dialog>
      <DialogTrigger render={trigger} />
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">
              Providers
            </span>
            <DialogClose
              render={<Button size="icon-xs" variant="ghost" />}
              aria-label="Close"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
            </DialogClose>
          </div>
          <div className="relative">
            <HugeiconsIcon
              icon={Search01Icon}
              className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              autoFocus
              placeholder="Search providers"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 rounded-md ps-8"
            />
          </div>
          <div className="max-h-[22rem] overflow-y-auto rounded-md border border-border/50">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No providers match “{query}”.
              </p>
            ) : (
              filtered.map((p) => (
                <CatalogRow
                  key={p.id}
                  provider={p}
                  expanded={expandedId === p.id}
                  onToggle={() =>
                    setExpandedId((cur) => (cur === p.id ? null : p.id))
                  }
                  onChanged={onChanged}
                />
              ))
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {providers.length} providers available. Keys are stored in
            opencode&apos;s own auth so they work in your terminal too.
          </p>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function CatalogRow({
  provider,
  expanded,
  onToggle,
  onChanged,
}: {
  provider: OpencodeInventoryProvider;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <div className="border-b border-border/40 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/40"
      >
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {provider.name}
        </span>
        {provider.connected ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="size-3"
              aria-hidden
            />
            Connected
          </span>
        ) : (
          <HugeiconsIcon
            icon={Add01Icon}
            className="size-3.5 text-muted-foreground"
            aria-hidden
          />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2.5">
          <ConnectKeyForm
            providerId={provider.id}
            connected={provider.connected}
            onChanged={onChanged}
          />
        </div>
      )}
    </div>
  );
}

function ConnectKeyForm({
  providerId,
  connected,
  onChanged,
}: {
  providerId: string;
  connected: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const save = async () => {
    if (value.trim().length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      await runOpencodeMutation((client) =>
        Effect.runPromise(
          client.agent.opencodeSetProviderAuth({
            providerId,
            apiKey: value.trim(),
          }),
        ),
      );
      setValue("");
      setStatus("Connected.");
      onChanged();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await runOpencodeMutation((client) =>
        Effect.runPromise(
          client.agent.opencodeRemoveProviderAuth({ providerId }),
        ),
      );
      onChanged();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={reveal ? "text" : "password"}
            placeholder={`${providerId.toUpperCase()}_API_KEY`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            className="h-8 rounded-md font-mono text-[11px]"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={reveal ? "Hide key" : "Reveal key"}
            tabIndex={-1}
          >
            <HugeiconsIcon
              icon={reveal ? ViewOffIcon : ViewIcon}
              className="size-3.5"
            />
          </button>
        </div>
        <Button
          size="xs"
          onClick={() => void save()}
          disabled={busy || value.trim().length === 0}
        >
          Save
        </Button>
        {connected && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void disconnect()}
            disabled={busy}
          >
            Remove
          </Button>
        )}
      </div>
      {status !== null && (
        <p className="text-[11px] text-muted-foreground">{status}</p>
      )}
    </div>
  );
}

/* ─────────────────────────── Custom provider ─────────────────────────── */

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function CustomProviderDialog({
  onChanged,
  trigger,
}: {
  onChanged: () => void;
  trigger: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<{ id: string; name: string }[]>([
    { id: "", name: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = slugify(name);
  const validModels = models.filter((m) => m.id.trim().length > 0);
  const canSubmit =
    name.trim().length > 0 &&
    baseURL.trim().length > 0 &&
    apiKey.trim().length > 0 &&
    validModels.length > 0;

  const reset = () => {
    setName("");
    setBaseURL("");
    setApiKey("");
    setModels([{ id: "", name: "" }]);
    setError(null);
    setBusy(false);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await runOpencodeMutation((client) =>
        Effect.runPromise(
          client.agent.opencodeAddCustomProvider({
            id,
            name: name.trim(),
            baseURL: baseURL.trim(),
            apiKey: apiKey.trim(),
            models: validModels.map((m) => ({
              id: m.id.trim(),
              name: m.name.trim().length > 0 ? m.name.trim() : m.id.trim(),
            })),
          }),
        ),
      );
      onChanged();
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">
              Custom provider
            </span>
            <DialogClose
              render={<Button size="icon-xs" variant="ghost" />}
              aria-label="Close"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
            </DialogClose>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Any OpenAI-compatible endpoint. opencode talks to it via
            <code className="mx-1 font-mono">@ai-sdk/openai-compatible</code>.
          </p>

          <Field label="Name">
            <Input
              autoFocus
              placeholder="My Gateway"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 rounded-md"
            />
          </Field>
          {name.trim().length > 0 && (
            <p className="-mt-1 text-[10px] text-muted-foreground/70">
              id: <code className="font-mono">{id || "—"}</code>
            </p>
          )}

          <Field label="Base URL">
            <Input
              placeholder="https://api.example.com/v1"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              className="h-9 rounded-md font-mono text-[11px]"
            />
          </Field>

          <Field label="API key">
            <Input
              type="password"
              placeholder="sk-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-9 rounded-md font-mono text-[11px]"
            />
          </Field>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Models
            </span>
            <div className="flex flex-col gap-1.5">
              {models.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    placeholder="model-id"
                    value={m.id}
                    onChange={(e) =>
                      setModels((cur) =>
                        cur.map((x, j) =>
                          j === i ? { ...x, id: e.target.value } : x,
                        ),
                      )
                    }
                    className="h-8 rounded-md font-mono text-[11px]"
                  />
                  <Input
                    placeholder="Display name (optional)"
                    value={m.name}
                    onChange={(e) =>
                      setModels((cur) =>
                        cur.map((x, j) =>
                          j === i ? { ...x, name: e.target.value } : x,
                        ),
                      )
                    }
                    className="h-8 rounded-md text-[11px]"
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() =>
                      setModels((cur) =>
                        cur.length === 1
                          ? [{ id: "", name: "" }]
                          : cur.filter((_, j) => j !== i),
                      )
                    }
                    aria-label="Remove model"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              size="xs"
              variant="ghost"
              className="self-start"
              onClick={() => setModels((cur) => [...cur, { id: "", name: "" }])}
            >
              <HugeiconsIcon icon={Add01Icon} className="mr-1 size-3" />
              Add model
            </Button>
          </div>

          {error !== null && (
            <p className="text-[11px] text-rose-400">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <DialogClose render={<Button size="sm" variant="ghost" />}>
              Cancel
            </DialogClose>
            <Button
              size="sm"
              disabled={!canSubmit || busy}
              onClick={() => void submit()}
            >
              {busy ? (
                <ShimmerText as="span">Saving…</ShimmerText>
              ) : (
                "Add provider"
              )}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

/* ───────────────────────────── Models ────────────────────────────────── */

function ModelsSection({
  connected,
}: {
  connected: ReadonlyArray<OpencodeInventoryProvider>;
}) {
  const modelVisible = useSettingsStore(
    (s) => s.opencodeModelVisibleByProvider,
  );
  const setModelVisible = useSettingsStore((s) => s.setOpencodeModelVisible);

  const selectedCount = useMemo(() => {
    let n = 0;
    for (const p of connected) {
      for (const m of p.models) {
        if (modelVisible[p.id]?.[m.id] !== false) n += 1;
      }
    }
    return n;
  }, [connected, modelVisible]);

  return (
    <Collapsible>
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            Models
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            {selectedCount} selected
          </span>
        </div>
        <CollapsibleTrigger
          render={
            <Button size="xs" variant="outline">
              Configure
            </Button>
          }
        />
      </div>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-3">
          {connected.map((p) => (
            <div key={p.id} className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                {p.name}
              </span>
              <div className="overflow-hidden rounded-md border border-border/50 bg-background/45">
                {p.models.map((m) => {
                  const checked = modelVisible[p.id]?.[m.id] !== false;
                  return (
                    <div
                      key={m.id}
                      className="flex min-h-9 items-center gap-2 border-b border-border/40 px-2.5 py-1.5 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                        {m.label}
                      </span>
                      <Switch
                        checked={checked}
                        onCheckedChange={(next) =>
                          setModelVisible(p.id, m.id, next)
                        }
                        aria-label={`${checked ? "Hide" : "Show"} ${m.label}`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ──────────────────────────── Advanced ───────────────────────────────── */

function AdvancedSection({
  connected,
}: {
  connected: ReadonlyArray<OpencodeInventoryProvider>;
}) {
  const providerVisible = useSettingsStore((s) => s.opencodeProviderVisible);
  const setProviderVisible = useSettingsStore(
    (s) => s.setOpencodeProviderVisible,
  );
  const modelVisible = useSettingsStore(
    (s) => s.opencodeModelVisibleByProvider,
  );
  const defaultModel = useSettingsStore(
    (s) => s.defaultModelByProvider.opencode ?? "",
  );
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel);

  // Default-model choices = visible models of visible connected providers.
  const modelItems = useMemo(() => {
    const items: { value: string; label: string }[] = [];
    for (const p of connected) {
      if (providerVisible[p.id] === false) continue;
      for (const m of p.models) {
        if (modelVisible[p.id]?.[m.id] === false) continue;
        items.push({ value: m.id, label: `${p.name} · ${m.label}` });
      }
    }
    return items;
  }, [connected, providerVisible, modelVisible]);

  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="self-start text-muted-foreground"
          >
            Advanced
          </Button>
        }
      />
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-4">
          {modelItems.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                Default model
              </span>
              <Select
                value={defaultModel}
                onValueChange={(next) =>
                  setDefaultModel("opencode", next as string)
                }
                items={modelItems}
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {modelItems.map((it) => (
                    <SelectItem key={it.value} value={it.value}>
                      {it.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Show in picker
            </span>
            <div className="overflow-hidden rounded-md border border-border/50 bg-background/45">
              {connected.map((p) => {
                const checked = providerVisible[p.id] !== false;
                return (
                  <div
                    key={p.id}
                    className="flex min-h-9 items-center gap-2 border-b border-border/40 px-2.5 py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                      {p.name}
                    </span>
                    <Switch
                      checked={checked}
                      onCheckedChange={(next) => setProviderVisible(p.id, next)}
                      aria-label={`${checked ? "Hide" : "Show"} ${p.name}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
