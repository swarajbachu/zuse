import type { PokemonRarity, PokemonSummary } from "@zuse/wire";

import { cn } from "~/lib/utils";

const RARITY_CLASS: Record<PokemonRarity, string> = {
  common: "text-zinc-300",
  uncommon: "text-emerald-300",
  rare: "text-sky-300",
  epic: "text-fuchsia-300",
  legendary: "text-amber-300",
};

export function PokemonSprite({
  pokemon,
  className,
}: {
  readonly pokemon: PokemonSummary | null;
  readonly className?: string;
}) {
  if (pokemon === null || pokemon.spriteUrl === null) {
    return (
      <span
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground",
          className,
        )}
      >
        ?
      </span>
    );
  }

  return (
    <img
      src={pokemon.spriteUrl}
      alt={pokemon.name}
      className={cn("size-5 shrink-0 object-contain", className)}
      loading="lazy"
      draggable={false}
    />
  );
}

export function PokemonRarityText({
  rarity,
  className,
}: {
  readonly rarity: PokemonRarity;
  readonly className?: string;
}) {
  return (
    <span className={cn("capitalize", RARITY_CLASS[rarity], className)}>
      {rarity}
    </span>
  );
}
