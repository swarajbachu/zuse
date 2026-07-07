# Pokemon Worktrees and Pokedex

Pokemon worktrees replace the old random cool-name generator with a global,
catalog-backed unlock system. Each newly created worktree unlocks one Pokemon,
uses that Pokemon as the branch and folder name, and contributes to an app-wide
Pokedex score.

## Catalog

The catalog lives in `apps/server/src/pokemon/catalog.ts` and contains Pokemon
from generations 1 through 9. Each entry includes:

- dex number
- slug and display name
- generation
- evolution family id
- rarity
- point value
- primary PokemonDB sprite URL

Rarity is deterministic catalog data, not random per unlock. Point values are:

- common: 10
- uncommon: 25
- rare: 75
- epic: 150
- legendary: 300

The catalog also derives additional PokemonDB sprite variant URLs for unlocked
Pokemon. Variants are best-effort because older sprite sets do not exist for
every species.

## Worktree Name Allocation

Worktree creation uses `allocatePokemonName()` in
`apps/server/src/pokemon/allocator.ts`.

The allocator checks names that are already unavailable from three places:

- existing worktree database rows
- existing folders in the worktree base directory
- existing local git branches

It also checks globally unlocked Pokemon numbers from `pokemon_unlocks`.

Allocation rules:

1. Pick an unused Pokemon family.
2. Unlock the first available species in that family from base form forward.
3. Use the bare Pokemon slug as the worktree folder and branch name.
4. If a species slug is unavailable, try the next unlocked-eligible evolution.
5. Once every species in that evolution line is unlocked, reuse the seed species
   with `-vN` suffixes such as `bulbasaur-v2`.

Evolution order matters: evolved Pokemon do not unlock before the base species in
their family. `-vN` names are visual variants of the same Pokemon identity, not
new Pokedex species.

## Persistence

Migration `0018_pokemon_worktrees` adds:

- `worktrees.pokemon_number`, nullable for legacy worktrees
- `pokemon_unlocks`, keyed by `pokemon_number`

The migration is idempotent and safe to rerun. Legacy worktrees remain valid even
when they have no Pokemon metadata.

When a new worktree is created, the selected Pokemon number is stored on the
worktree row and inserted into `pokemon_unlocks`. The unlock row is global across
the app, not per repository.

## Sprite Caching

Sprites are not bundled with the app and are not hotlinked in normal unlocked UI.
On unlock, the server downloads the primary sprite and known variants into:

```text
<userData>/pokemon-sprites/
```

Cached sprite stems are:

- `<dex-number>.<ext>` for the default sprite
- `<dex-number>-<variant>.<ext>` for variants

If a download fails, unlock creation still succeeds. The Pokedex lazily retries
missing default and variant sprites through `pokemon.ensureSpriteCached`.

## Internal Asset URLs

The Electron `zuse://` protocol serves cached Pokemon sprites through:

```text
zuse://pokemon/<dex-number>
zuse://pokemon/<dex-number>-<variant>
```

The protocol only serves files from the known `pokemon-sprites` directory and
rejects path traversal by requiring a single safe path segment.

## RPC and Wire Types

Pokemon wire types live in `packages/wire/src/pokemon.ts`.

The RPC surface includes:

- `pokemon.pokedex`: returns all catalog entries joined with unlock state
- `pokemon.ensureSpriteCached`: retries sprite caching and returns the updated
  Pokedex entry

`Worktree` also includes nullable Pokemon summary metadata so existing UI chips
can show the sprite, rarity, and display name without fetching the full Pokedex.

## Renderer UI

The renderer store is `apps/renderer/src/store/pokemon.ts`.

The Pokedex is reachable from the sidebar/settings area and supports:

- search
- generation filtering
- rarity filtering
- unlocked/locked filtering
- global unlocked count and point summary
- click-to-open detail dialog
- zoomable sprite preview
- evolution line display
- sprite variants for unlocked Pokemon

Locked entries show dex number, name, rarity, and a neutral silhouette. Unlocked
entries use cached `zuse://pokemon/...` sprite URLs when available.

## Development Behavior

In dev mode, the renderer marks a small deterministic set of Pokemon as unlocked
so the Pokedex has useful visual states without creating many worktrees. This is
renderer-only display behavior and does not write unlock rows.

## Tests

Coverage includes:

- allocator behavior for bare names, evolution fallback, and `-vN` fallback
- migration idempotence
- wire/schema round trips for Pokemon and Worktree metadata
- existing renderer tests and production renderer build coverage
