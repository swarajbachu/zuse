import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Loading02Icon,
  PlugSocketIcon,
  RefreshIcon,
  Search01Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import { Effect } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";

import type { OpencodeInventoryProvider } from "@zuse/wire";

import { getRpcClient } from "~/lib/rpc-client";
import { openExternal } from "~/lib/use-provider-login";
import { cn } from "~/lib/utils";
import { useOpencodeInventory } from "~/store/opencode-inventory";
import { useSettingsStore } from "~/store/settings";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
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
import { ShimmerText } from "~/components/ui/shimmer-text";
import { Switch } from "~/components/ui/switch";

/**
 * OpenCode is a meta-harness fronting ~150 model providers (models.dev) plus
 * any OpenAI-compatible endpoint the user brings. This panel replaces the
 * generic model-default / api-key block on the OpenCode card:
 *
 *  - **Providers** — browse the catalog (logo + "get an API key" link) and
 *    connect one by pasting its key, or define a custom OpenAI-compatible
 *    provider. Keys are written through to opencode's own `auth.json`.
 *  - **Models** — a searchable dialog to pick which connected models show.
 *  - **Advanced** — default model + per-provider picker visibility.
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
  const refresh = () => void refreshInventory();

  return (
    <div className="flex flex-col gap-5">
      <ProvidersSection
        providers={providers}
        connected={connected}
        loading={invLoading}
        loaded={inventory !== null}
        onRefresh={refresh}
      />
      {connected.length > 0 && (
        <>
          <ModelsSection connected={connected} />
          <AdvancedSection connected={connected} />
        </>
      )}
    </div>
  );
}

/** Fire an opencode provider-management RPC (caller refreshes inventory). */
const rpc = async (
  fn: (client: Awaited<ReturnType<typeof getRpcClient>>) => Promise<unknown>,
): Promise<void> => {
  const client = await getRpcClient();
  await fn(client);
};

/* ─────────────────────────────── Logo ────────────────────────────────── */

const LOGO_BASE = "https://models.dev/logos";

/**
 * Provider mark. models.dev serves a (usually monochrome black) SVG per
 * catalog provider id. Rendering it as an `<img>` leaves it black — invisible
 * on a dark card. Instead we paint the SVG as a CSS **mask** over a
 * `currentColor` fill, so the glyph adapts to the theme (near-white on dark,
 * near-black on light). A hidden preload verifies the URL first; on 404 /
 * offline / custom providers we fall back to a monogram so every row has a
 * consistent glyph.
 */
function ProviderLogo({
  id,
  name,
  custom,
  className,
}: {
  id: string;
  name: string;
  custom?: boolean;
  className?: string;
}) {
  const canLogo = !custom && id.length > 0;
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (!canLogo) {
      setOk(false);
      return;
    }
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setOk(true);
    img.onerror = () => alive && setOk(false);
    img.src = `${LOGO_BASE}/${id}.svg`;
    return () => {
      alive = false;
    };
  }, [id, canLogo]);

  const url = `${LOGO_BASE}/${id}.svg`;
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted/50 ring-1 ring-inset ring-border/50",
        className,
      )}
    >
      {ok ? (
        <span
          aria-hidden
          className="size-4 bg-foreground/90"
          style={{
            maskImage: `url("${url}")`,
            WebkitMaskImage: `url("${url}")`,
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
            maskSize: "contain",
            WebkitMaskSize: "contain",
          }}
        />
      ) : (
        <span className="text-[11px] font-semibold text-muted-foreground">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

/* ────────────────────────────── Providers ────────────────────────────── */

function ProvidersSection({
  providers,
  connected,
  loading,
  loaded,
  onRefresh,
}: {
  providers: ReadonlyArray<OpencodeInventoryProvider>;
  connected: ReadonlyArray<OpencodeInventoryProvider>;
  loading: boolean;
  loaded: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-foreground">
            Providers
          </span>
          <span className="text-[11px] text-muted-foreground/70">
            {connected.length} configured
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh providers"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            className={cn("size-3.5", loading && "animate-spin")}
            aria-hidden
          />
        </button>
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-3 text-xs text-muted-foreground">
          <HugeiconsIcon
            icon={Loading02Icon}
            className="size-3.5 animate-spin"
            aria-hidden
          />
          <ShimmerText as="span">Loading providers…</ShimmerText>
        </div>
      ) : connected.length === 0 ? (
        <ProviderBrowserDialog
          providers={providers}
          onChanged={onRefresh}
          trigger={
            <Button size="sm" className="self-start">
              Add your first provider
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {connected.map((p) => (
              <ConnectedProviderRow
                key={p.id}
                provider={p}
                onChanged={onRefresh}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <ProviderBrowserDialog
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
                  Custom endpoint
                </Button>
              }
            />
          </div>
        </>
      )}
    </div>
  );
}

/** A compact connected-provider row (logo · name · models · remove). */
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
      await rpc((client) =>
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
    <div className="group flex items-center gap-2.5 rounded-lg border border-border/50 bg-background/40 px-3 py-2 transition-colors hover:border-border">
      <ProviderLogo
        id={provider.id}
        name={provider.name}
        custom={provider.custom}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">
            {provider.name}
          </span>
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            className="size-3 shrink-0 text-emerald-400"
            aria-hidden
          />
        </div>
        <span className="text-[10px] text-muted-foreground/70">
          {provider.custom ? "Custom · " : ""}
          {provider.models.length} model
          {provider.models.length === 1 ? "" : "s"}
        </span>
      </div>
      <button
        type="button"
        onClick={() => void remove()}
        disabled={busy}
        aria-label={`Remove ${provider.name}`}
        title="Remove credential"
        className="rounded p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-muted/60 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
      >
        <HugeiconsIcon
          icon={busy ? Loading02Icon : Delete02Icon}
          className={cn("size-3.5", busy && "animate-spin")}
          aria-hidden
        />
      </button>
    </div>
  );
}

/* ───────────────────────── Provider browser ──────────────────────────── */

// Surfaced first (before "View all") — the providers most people reach for.
const POPULAR_IDS = [
  "opencode",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "github-copilot",
  "vercel",
  "groq",
  "xai",
  "deepseek",
  "mistral",
  "azure",
];

function ProviderBrowserDialog({
  providers,
  onChanged,
  trigger,
}: {
  providers: ReadonlyArray<OpencodeInventoryProvider>;
  onChanged: () => void;
  trigger: React.ReactElement;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const sorted = useMemo(() => {
    const rank = new Map(POPULAR_IDS.map((id, i) => [id, i]));
    return [...providers].sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }, [providers]);

  const filtered = useMemo(() => {
    if (!searching) return sorted;
    return sorted.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    );
  }, [sorted, searching, q]);

  const CURATED = 6;
  const shown = searching || showAll ? filtered : filtered.slice(0, CURATED);
  const hiddenCount = filtered.length - shown.length;

  return (
    <Dialog onOpenChange={(open) => open && setShowAll(false)}>
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

          <div className="-mx-1 max-h-[22rem] overflow-y-auto px-1">
            {shown.length === 0 ? (
              <p className="px-3 py-10 text-center text-xs text-muted-foreground">
                No providers match “{query}”.
              </p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {shown.map((p) => (
                  <ProviderBrowserRow
                    key={p.id}
                    provider={p}
                    onChanged={onChanged}
                  />
                ))}
              </div>
            )}
          </div>

          {!searching && hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="rounded-md py-1 text-center text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              View all {filtered.length} providers
            </button>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** One row in the browser: logo + name, expands into the key form. */
function ProviderBrowserRow({
  provider,
  onChanged,
}: {
  provider: OpencodeInventoryProvider;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      if (next) {
        // Expanding a row near the bottom of the scroll area would otherwise
        // open its key field off-screen — pull it into view.
        requestAnimationFrame(() =>
          ref.current?.scrollIntoView({ block: "nearest" }),
        );
      }
      return next;
    });

  return (
    <div
      ref={ref}
      className={cn(
        "rounded-xl transition-colors",
        open
          ? "bg-muted/40 ring-1 ring-inset ring-border/60"
          : "hover:bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left"
      >
        <ProviderLogo
          id={provider.id}
          name={provider.name}
          custom={provider.custom}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {provider.name}
        </span>
        {provider.connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="size-3"
              aria-hidden
            />
            Connected
          </span>
        ) : (
          <span
            className={cn(
              "shrink-0 text-[11px] font-medium transition-colors",
              open ? "text-foreground" : "text-muted-foreground/70",
            )}
          >
            {open ? "Close" : "Connect"}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2.5 pb-3 pt-0.5">
          {provider.apiKeyUrl.length > 0 && (
            <button
              type="button"
              onClick={() => openExternal(provider.apiKeyUrl)}
              className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Get an API key
              <HugeiconsIcon
                icon={ArrowUpRight01Icon}
                className="size-3"
                aria-hidden
              />
            </button>
          )}
          <ConnectKeyForm
            providerId={provider.id}
            placeholder={
              provider.apiKeyEnv.length > 0 ? provider.apiKeyEnv : "API key"
            }
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
  placeholder,
  connected,
  onChanged,
}: {
  providerId: string;
  placeholder: string;
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
      await rpc((client) =>
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
      await rpc((client) =>
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
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            disabled={busy}
            className="h-8 rounded-md pe-8 font-mono text-[11px]"
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
          {busy ? (
            <HugeiconsIcon
              icon={Loading02Icon}
              className="size-3.5 animate-spin"
            />
          ) : (
            "Save"
          )}
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
      await rpc((client) =>
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
              Custom endpoint
            </span>
            <DialogClose
              render={<Button size="icon-xs" variant="ghost" />}
              aria-label="Close"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
            </DialogClose>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Any OpenAI-compatible endpoint (vLLM, LM Studio, Groq, LiteLLM, a
            proxy…). opencode connects via{" "}
            <code className="font-mono">@ai-sdk/openai-compatible</code>.
          </p>

          <Field label="Name">
            <Input
              autoFocus
              placeholder="My Gateway"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 rounded-md"
            />
            {name.trim().length > 0 && (
              <span className="text-[10px] text-muted-foreground/70">
                id: <code className="font-mono">{id || "—"}</code>
              </span>
            )}
          </Field>

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

          <Field label="Models">
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
                  <button
                    type="button"
                    onClick={() =>
                      setModels((cur) =>
                        cur.length === 1
                          ? [{ id: "", name: "" }]
                          : cur.filter((_, j) => j !== i),
                      )
                    }
                    aria-label="Remove model"
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
                  </button>
                </div>
              ))}
              <Button
                size="xs"
                variant="ghost"
                className="self-start"
                onClick={() =>
                  setModels((cur) => [...cur, { id: "", name: "" }])
                }
              >
                <HugeiconsIcon icon={Add01Icon} className="mr-1 size-3" />
                Add model
              </Button>
            </div>
          </Field>

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
                "Add endpoint"
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

  const { selected, total } = useMemo(() => {
    let sel = 0;
    let tot = 0;
    for (const p of connected) {
      for (const m of p.models) {
        tot += 1;
        if (modelVisible[p.id]?.[m.id] !== false) sel += 1;
      }
    }
    return { selected: sel, total: tot };
  }, [connected, modelVisible]);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-foreground">Models</span>
        <span className="text-[11px] text-muted-foreground/70">
          {selected} of {total} shown
        </span>
      </div>
      <ModelFilterDialog connected={connected} />
    </div>
  );
}

function ModelFilterDialog({
  connected,
}: {
  connected: ReadonlyArray<OpencodeInventoryProvider>;
}) {
  const [query, setQuery] = useState("");
  const modelVisible = useSettingsStore(
    (s) => s.opencodeModelVisibleByProvider,
  );
  const setModelVisible = useSettingsStore((s) => s.setOpencodeModelVisible);

  const q = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      connected
        .map((p) => ({
          provider: p,
          models: p.models.filter(
            (m) => q.length === 0 || m.label.toLowerCase().includes(q),
          ),
        }))
        .filter((g) => g.models.length > 0),
    [connected, q],
  );

  return (
    <Dialog onOpenChange={() => setQuery("")}>
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            Configure
          </Button>
        }
      />
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">
              Models
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
              placeholder="Filter models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 rounded-md ps-8"
            />
          </div>

          <div className="flex max-h-[24rem] flex-col gap-4 overflow-y-auto">
            {groups.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                No models match “{query}”.
              </p>
            ) : (
              groups.map(({ provider, models }) => (
                <div key={provider.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 px-1">
                    <ProviderLogo
                      id={provider.id}
                      name={provider.name}
                      custom={provider.custom}
                      className="size-4"
                    />
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                      {provider.name}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    {models.map((m) => {
                      const checked =
                        modelVisible[provider.id]?.[m.id] !== false;
                      return (
                        <label
                          key={m.id}
                          className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(next) =>
                              setModelVisible(provider.id, m.id, next === true)
                            }
                          />
                          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                            {m.label}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
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
            className="-ml-2 self-start text-muted-foreground"
          >
            Advanced
          </Button>
        }
      />
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-4">
          {modelItems.length > 0 && (
            <Field label="Default model">
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
            </Field>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Show in picker
            </span>
            <div className="flex flex-col gap-1.5">
              {connected.map((p) => {
                const checked = providerVisible[p.id] !== false;
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-background/40 px-3 py-2"
                  >
                    <ProviderLogo
                      id={p.id}
                      name={p.name}
                      custom={p.custom}
                      className="size-5"
                    />
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
