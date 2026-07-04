import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { PokemonPokedexEntry, PokemonRarity } from "@zuse/wire";

import { PokemonRarityText } from "../pokemon.tsx";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select.tsx";
import { Slider } from "../ui/slider.tsx";
import { usePokemonStore } from "../../store/pokemon.ts";

type UnlockFilter = "all" | "unlocked" | "locked";
type GenerationFilter = "all" | `${number}`;

const rarityOrder: readonly PokemonRarity[] = [
  "common",
  "uncommon",
  "rare",
  "epic",
  "legendary",
];

const DEV_UNLOCKED_NUMBERS = new Set([1, 4, 7, 25, 94, 133, 149, 150, 151]);
const TILE_MIN_WIDTH = 132;
const TILE_HEIGHT = 148;
const GRID_OVERSCAN_ROWS = 4;

export function PokedexPane() {
  const storedEntries = usePokemonStore((s) => s.entries);
  const loading = usePokemonStore((s) => s.loading);
  const error = usePokemonStore((s) => s.error);
  const hydrate = usePokemonStore((s) => s.hydrate);
  const ensureSpriteCached = usePokemonStore((s) => s.ensureSpriteCached);
  const [query, setQuery] = useState("");
  const [unlockFilter, setUnlockFilter] = useState<UnlockFilter>("all");
  const [generation, setGeneration] = useState<GenerationFilter>("all");
  const [rarity, setRarity] = useState<"all" | PokemonRarity>("all");
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [zoom, setZoom] = useState(2);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState({
    height: 0,
    scrollTop: 0,
    width: 0,
  });

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const entries = useMemo(() => {
    if (!import.meta.env.DEV) return storedEntries;
    return storedEntries.map((entry) => {
      if (entry.unlocked || !DEV_UNLOCKED_NUMBERS.has(entry.number)) {
        return entry;
      }
      return {
        ...entry,
        unlocked: true,
        spriteUrl: entry.silhouetteUrl,
      };
    });
  }, [storedEntries]);

  const stats = useMemo(() => {
    let unlocked = 0;
    let points = 0;
    for (const entry of entries) {
      if (!entry.unlocked) continue;
      unlocked += 1;
      points += entry.points;
    }
    return { unlocked, points, total: entries.length };
  }, [entries]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (unlockFilter === "unlocked" && !entry.unlocked) return false;
      if (unlockFilter === "locked" && entry.unlocked) return false;
      if (generation !== "all" && entry.generation !== Number(generation)) {
        return false;
      }
      if (rarity !== "all" && entry.rarity !== rarity) return false;
      if (needle === "") return true;
      return (
        entry.name.toLowerCase().includes(needle) ||
        entry.slug.includes(needle) ||
        String(entry.number).includes(needle)
      );
    });
  }, [entries, generation, query, rarity, unlockFilter]);

  const selected = useMemo(() => {
    if (selectedNumber === null) return null;
    return entries.find((entry) => entry.number === selectedNumber) ?? null;
  }, [entries, selectedNumber]);

  const virtualGrid = useMemo(() => {
    const columnCount = Math.max(
      1,
      Math.floor(Math.max(viewport.width, TILE_MIN_WIDTH) / TILE_MIN_WIDTH),
    );
    const columnWidth =
      viewport.width > 0 ? viewport.width / columnCount : TILE_MIN_WIDTH;
    const rowCount = Math.ceil(filtered.length / columnCount);
    const firstVisibleRow = Math.max(
      0,
      Math.floor(viewport.scrollTop / TILE_HEIGHT) - GRID_OVERSCAN_ROWS,
    );
    const lastVisibleRow = Math.min(
      rowCount,
      Math.ceil((viewport.scrollTop + viewport.height) / TILE_HEIGHT) +
        GRID_OVERSCAN_ROWS,
    );
    const startIndex = firstVisibleRow * columnCount;
    const endIndex = Math.min(filtered.length, lastVisibleRow * columnCount);
    const visible = filtered.slice(startIndex, endIndex);

    return {
      columnCount,
      columnWidth,
      startIndex,
      totalHeight: rowCount * TILE_HEIGHT,
      visible,
    };
  }, [filtered, viewport]);

  const handleGridScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const current = scrollRef.current;
      if (current === null) return;
      setViewport((prev) =>
        prev.scrollTop === current.scrollTop
          ? prev
          : { ...prev, scrollTop: current.scrollTop },
      );
    });
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;

    const updateSize = () => {
      setViewport((prev) => {
        const width = node.clientWidth;
        const height = node.clientHeight;
        const scrollTop = node.scrollTop;
        if (
          prev.width === width &&
          prev.height === height &&
          prev.scrollTop === scrollTop
        ) {
          return prev;
        }
        return { width, height, scrollTop };
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = 0;
    setViewport((prev) =>
      prev.scrollTop === 0 ? prev : { ...prev, scrollTop: 0 },
    );
  }, [generation, query, rarity, unlockFilter]);

  useEffect(() => {
    for (const entry of virtualGrid.visible) {
      if (
        entry.unlocked &&
        (entry.spriteUrl === null ||
          entry.variants.some((variant) => variant.spriteUrl === null))
      ) {
        void ensureSpriteCached(entry.number);
      }
    }
  }, [ensureSpriteCached, virtualGrid.visible]);

  useEffect(() => {
    if (
      selected !== null &&
      selected.unlocked &&
      (selected.spriteUrl === null ||
        selected.variants.some((variant) => variant.spriteUrl === null))
    ) {
      void ensureSpriteCached(selected.number);
    }
  }, [ensureSpriteCached, selected]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-normal">Pokedex</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {stats.unlocked}/{stats.total} unlocked · {stats.points} points
          </p>
        </div>
        {loading ? (
          <span className="text-xs text-muted-foreground">Loading…</span>
        ) : error !== null ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : null}
      </div>

      <div className="grid gap-2 md:grid-cols-[1fr_10rem_10rem_10rem]">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or number"
        />
        <Select
          value={unlockFilter}
          onValueChange={(value) => setUnlockFilter(value as UnlockFilter)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="unlocked">Unlocked</SelectItem>
            <SelectItem value="locked">Locked</SelectItem>
          </SelectPopup>
        </Select>
        <Select
          value={generation}
          onValueChange={(value) => setGeneration(value as GenerationFilter)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All generations</SelectItem>
            {Array.from({ length: 9 }, (_, i) => String(i + 1)).map((gen) => (
              <SelectItem key={gen} value={gen}>
                Gen {gen}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={rarity}
          onValueChange={(value) => setRarity(value as "all" | PokemonRarity)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All rarity</SelectItem>
            {rarityOrder.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border/50 bg-background"
        onScroll={handleGridScroll}
      >
        <div className="relative" style={{ height: virtualGrid.totalHeight }}>
          {virtualGrid.visible.map((entry, visibleIndex) => {
            const index = virtualGrid.startIndex + visibleIndex;
            const row = Math.floor(index / virtualGrid.columnCount);
            const column = index % virtualGrid.columnCount;
            return (
              <PokedexTile
                key={entry.number}
                entry={entry}
                onSelect={() => {
                  setSelectedNumber(entry.number);
                  setZoom(2);
                }}
                style={{
                  height: TILE_HEIGHT,
                  left: column * virtualGrid.columnWidth,
                  top: row * TILE_HEIGHT,
                  width: virtualGrid.columnWidth,
                }}
              />
            );
          })}
        </div>
      </div>
      <PokemonDetailDialog
        entry={selected}
        onOpenChange={(open) => {
          if (!open) setSelectedNumber(null);
        }}
        onZoomChange={setZoom}
        zoom={zoom}
      />
    </section>
  );
}

function PokedexTile({
  entry,
  onSelect,
  style,
}: {
  readonly entry: PokemonPokedexEntry;
  readonly onSelect: () => void;
  readonly style: CSSProperties;
}) {
  return (
    <button
      type="button"
      className="absolute flex flex-col overflow-hidden border-b border-r border-border/35 p-2.5 text-left outline-none hover:z-10 hover:bg-accent/45 focus-visible:z-10 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onSelect}
      style={style}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>#{String(entry.number).padStart(4, "0")}</span>
        <PokemonRarityText rarity={entry.rarity} className="truncate" />
      </div>
      <div className="mt-1.5 flex h-16 w-full shrink-0 items-center justify-center">
        {entry.unlocked && entry.spriteUrl !== null ? (
          <img
            src={entry.spriteUrl}
            alt={entry.name}
            className="mx-auto block size-14 object-contain"
            decoding="async"
            width={56}
            height={56}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <img
            src={entry.silhouetteUrl}
            alt=""
            aria-hidden="true"
            className="mx-auto block size-14 object-contain opacity-45 grayscale brightness-0"
            decoding="async"
            width={56}
            height={56}
            loading="lazy"
            draggable={false}
          />
        )}
      </div>
      <div className="mt-1.5 min-w-0">
        <div className="truncate text-[13px] font-medium">{entry.name}</div>
        <div className="text-[11px] text-muted-foreground">
          Gen {entry.generation} · {entry.points} pts
        </div>
      </div>
    </button>
  );
}

function PokemonDetailDialog({
  entry,
  zoom,
  onZoomChange,
  onOpenChange,
}: {
  readonly entry: PokemonPokedexEntry | null;
  readonly zoom: number;
  readonly onZoomChange: (zoom: number) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const open = entry !== null;
  const spriteSrc =
    entry !== null && entry.unlocked && entry.spriteUrl !== null
      ? entry.spriteUrl
      : entry?.silhouetteUrl;
  const imageSize = `${zoom * 6}rem`;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-2xl">
        {entry === null ? null : (
          <>
            <DialogHeader>
              <div className="flex items-start justify-between gap-6 pr-8">
                <div className="min-w-0">
                  <DialogTitle>{entry.name}</DialogTitle>
                  <DialogDescription>
                    #{String(entry.number).padStart(4, "0")} · Gen{" "}
                    {entry.generation} · {entry.points} pts
                  </DialogDescription>
                </div>
                <PokemonRarityText rarity={entry.rarity} />
              </div>
            </DialogHeader>
            <DialogPanel className="space-y-5">
              <div className="h-80 overflow-auto rounded-md border border-border/50 bg-muted p-6">
                <div className="flex min-h-full min-w-full items-center justify-center">
                  {spriteSrc !== undefined ? (
                    <img
                      src={spriteSrc}
                      alt={entry.unlocked ? entry.name : ""}
                      aria-hidden={entry.unlocked ? undefined : "true"}
                      className={
                        entry.unlocked && entry.spriteUrl !== null
                          ? "mx-auto block object-contain"
                          : "mx-auto block object-contain opacity-50 grayscale brightness-0"
                      }
                      decoding="async"
                      draggable={false}
                      style={{ height: imageSize, width: imageSize }}
                    />
                  ) : null}
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">Zoom</span>
                  <span className="text-muted-foreground">
                    {Math.round(zoom * 100)}%
                  </span>
                </div>
                <Slider
                  aria-label="Sprite zoom"
                  max={5}
                  min={1}
                  onValueChange={(value) => {
                    onZoomChange(Array.isArray(value) ? value[0] : value);
                  }}
                  step={0.25}
                  value={zoom}
                />
              </div>
              {entry.evolutionLine.length > 1 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Evolution</div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] gap-2">
                    {entry.evolutionLine.map((step) => {
                      const stepSrc =
                        step.unlocked && step.spriteUrl !== null
                          ? step.spriteUrl
                          : step.silhouetteUrl;
                      return (
                        <div
                          key={step.number}
                          className="flex min-w-0 flex-col items-center rounded-md border border-border/50 p-2 text-center"
                        >
                          <div className="flex h-16 w-full items-center justify-center">
                            <img
                              src={stepSrc}
                              alt={step.unlocked ? step.name : ""}
                              aria-hidden={step.unlocked ? undefined : "true"}
                              className={
                                step.unlocked && step.spriteUrl !== null
                                  ? "mx-auto block size-14 object-contain"
                                  : "mx-auto block size-14 object-contain opacity-50 grayscale brightness-0"
                              }
                              decoding="async"
                              width={56}
                              height={56}
                              draggable={false}
                              loading="lazy"
                            />
                          </div>
                          <div className="mt-2 w-full truncate text-xs font-medium">
                            {step.name}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            #{String(step.number).padStart(4, "0")}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {entry.unlocked &&
              entry.variants.some((variant) => variant.spriteUrl !== null) ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Variants</div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-2">
                    {entry.variants
                      .filter((variant) => variant.spriteUrl !== null)
                      .map((variant) => (
                        <div
                          key={variant.id}
                          className="flex min-w-0 flex-col items-center rounded-md border border-border/50 p-2 text-center"
                        >
                          <div className="flex h-20 w-full items-center justify-center">
                            <img
                              src={variant.spriteUrl ?? undefined}
                              alt={`${entry.name} ${variant.label}`}
                              className="mx-auto block size-16 object-contain"
                              decoding="async"
                              width={64}
                              height={64}
                              draggable={false}
                              loading="lazy"
                            />
                          </div>
                          <div className="mt-2 w-full truncate text-xs font-medium">
                            {variant.label}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <div className="rounded-md border border-border/50 p-3">
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div className="mt-1 font-medium">
                    {entry.unlocked ? "Unlocked" : "Locked"}
                  </div>
                </div>
                <div className="rounded-md border border-border/50 p-3">
                  <div className="text-xs text-muted-foreground">Slug</div>
                  <div className="mt-1 truncate font-medium">{entry.slug}</div>
                </div>
              </div>
            </DialogPanel>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
