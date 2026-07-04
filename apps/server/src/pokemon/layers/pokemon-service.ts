import { FileSystem, Path } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import { Effect, Layer } from "effect";

import {
  PokemonNotFoundError,
  PokemonEvolutionStep,
  PokemonPokedexEntry,
  PokemonSpriteVariant,
  WorktreeId,
} from "@zuse/wire";

import { AppPaths } from "../../app-paths.ts";
import {
  POKEMON_BY_NUMBER,
  POKEMON_CATALOG,
  pokemonFamilyFor,
  pokemonSpriteSourcesFor,
  pokemonSpriteStem,
} from "../catalog.ts";
import { PokemonService } from "../services/pokemon-service.ts";

interface UnlockRow {
  readonly pokemon_number: number;
  readonly worktree_id: string | null;
  readonly unlocked_at: string;
}

type CachedSpriteStems = ReadonlySet<string>;

const spriteUrlFor = (number: number, variantId = "default"): string =>
  `zuse://pokemon/${pokemonSpriteStem(number, variantId)}`;

const extensionFrom = (url: string, contentType: string | null): string => {
  const clean = url.split("?")[0] ?? url;
  const fromUrl = clean.slice(clean.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "avif"].includes(fromUrl)) {
    return fromUrl;
  }
  if (contentType?.includes("avif")) return "avif";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("gif")) return "gif";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg"))
    return "jpg";
  return "png";
};

export const PokemonServiceLive = Layer.effect(
  PokemonService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { userData } = yield* AppPaths;
    const spritesDir = path.join(userData, "pokemon-sprites");

    yield* fs.makeDirectory(spritesDir, { recursive: true }).pipe(Effect.orDie);

    const cachedSpriteStems = () =>
      Effect.gen(function* () {
        const entries = yield* fs
          .readDirectory(spritesDir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        const stems = new Set<string>();
        for (const entry of entries) {
          const dot = entry.lastIndexOf(".");
          if (dot > 0) stems.add(entry.slice(0, dot));
        }
        return stems;
      });

    const hasCachedSprite = (
      cached: CachedSpriteStems,
      number: number,
      variantId = "default",
    ) => cached.has(pokemonSpriteStem(number, variantId));

    const cacheSpriteSource = (
      number: number,
      variantId: string,
      sourceUrl: string,
      cached: Set<string>,
    ) =>
      Effect.gen(function* () {
        const stem = pokemonSpriteStem(number, variantId);
        if (cached.has(stem)) return;

        const response = yield* Effect.promise(async () => {
          try {
            return await fetch(sourceUrl);
          } catch {
            return null;
          }
        });
        if (response === null || !response.ok) return;

        const buffer = yield* Effect.promise(async () => {
          try {
            return await response.arrayBuffer();
          } catch {
            return new ArrayBuffer(0);
          }
        });
        const bytes = new Uint8Array(buffer);
        if (bytes.byteLength === 0) return;

        const ext = extensionFrom(
          sourceUrl,
          response.headers.get("content-type"),
        );
        yield* fs
          .writeFile(
            path.join(
              spritesDir,
              `${pokemonSpriteStem(number, variantId)}.${ext}`,
            ),
            bytes,
          )
          .pipe(Effect.ignoreLogged);
        cached.add(stem);
      });

    const cacheSprite = (number: number) =>
      Effect.gen(function* () {
        const pokemon = POKEMON_BY_NUMBER.get(number);
        if (pokemon === undefined) {
          return yield* Effect.fail(new PokemonNotFoundError({ number }));
        }
        const cached = yield* cachedSpriteStems();
        for (const source of pokemonSpriteSourcesFor(pokemon)) {
          yield* cacheSpriteSource(number, source.id, source.url, cached);
        }
      });

    const rowsByNumber = () =>
      Effect.gen(function* () {
        const rows = yield* sql<UnlockRow>`
          SELECT pokemon_number, worktree_id, unlocked_at
          FROM pokemon_unlocks
        `.pipe(Effect.orDie);
        return new Map(rows.map((row) => [row.pokemon_number, row]));
      });

    const entryFor = (
      number: number,
      rows: ReadonlyMap<number, UnlockRow>,
      cachedSprites: CachedSpriteStems,
    ) =>
      Effect.gen(function* () {
        const pokemon = POKEMON_BY_NUMBER.get(number);
        if (pokemon === undefined) {
          return yield* Effect.fail(new PokemonNotFoundError({ number }));
        }
        const unlock = rows.get(number);
        const cached =
          unlock === undefined
            ? false
            : hasCachedSprite(cachedSprites, number, "default");
        const variants = [];
        for (const source of pokemonSpriteSourcesFor(pokemon)) {
          if (source.id === "default") continue;
          const variantCached =
            unlock === undefined
              ? false
              : hasCachedSprite(cachedSprites, number, source.id);
          variants.push(
            PokemonSpriteVariant.make({
              id: source.id,
              label: source.label,
              spriteUrl: variantCached ? spriteUrlFor(number, source.id) : null,
            }),
          );
        }
        const evolutionLine = [];
        for (const familyMember of pokemonFamilyFor(pokemon)) {
          const familyUnlock = rows.get(familyMember.number);
          const familyCached =
            familyUnlock === undefined
              ? false
              : hasCachedSprite(cachedSprites, familyMember.number, "default");
          evolutionLine.push(
            PokemonEvolutionStep.make({
              number: familyMember.number,
              slug: familyMember.slug,
              name: familyMember.name,
              rarity: familyMember.rarity,
              unlocked: familyUnlock !== undefined,
              spriteUrl: familyCached
                ? spriteUrlFor(familyMember.number)
                : null,
              silhouetteUrl: familyMember.spriteUrl,
            }),
          );
        }
        return PokemonPokedexEntry.make({
          number: pokemon.number,
          slug: pokemon.slug,
          name: pokemon.name,
          generation: pokemon.generation,
          rarity: pokemon.rarity,
          points: pokemon.points,
          unlocked: unlock !== undefined,
          unlockedAt:
            unlock === undefined ? null : new Date(unlock.unlocked_at),
          worktreeId:
            unlock?.worktree_id === undefined || unlock.worktree_id === null
              ? null
              : WorktreeId.make(unlock.worktree_id),
          spriteUrl: cached ? spriteUrlFor(number) : null,
          silhouetteUrl: pokemon.spriteUrl,
          variants,
          evolutionLine,
        });
      });

    return PokemonService.of({
      pokedex: () =>
        Effect.gen(function* () {
          const rows = yield* rowsByNumber();
          const cachedSprites = yield* cachedSpriteStems();
          const entries: PokemonPokedexEntry[] = [];
          for (const pokemon of POKEMON_CATALOG) {
            entries.push(
              yield* entryFor(pokemon.number, rows, cachedSprites).pipe(
                Effect.orDie,
              ),
            );
          }
          return entries;
        }),
      ensureSpriteCached: (number) =>
        Effect.gen(function* () {
          yield* cacheSprite(number);
          const rows = yield* rowsByNumber();
          const cachedSprites = yield* cachedSpriteStems();
          return yield* entryFor(number, rows, cachedSprites);
        }),
      recordUnlock: (number, worktreeId) =>
        Effect.gen(function* () {
          const pokemon = POKEMON_BY_NUMBER.get(number);
          if (pokemon === undefined) return;
          const now = new Date().toISOString();
          yield* sql`
            INSERT INTO pokemon_unlocks
              (pokemon_number, worktree_id, unlocked_at)
            VALUES
              (${number}, ${worktreeId}, ${now})
            ON CONFLICT(pokemon_number) DO NOTHING
          `.pipe(Effect.orDie);
          yield* Effect.forkDaemon(
            cacheSprite(number).pipe(Effect.ignoreLogged),
          );
        }),
    });
  }),
);
