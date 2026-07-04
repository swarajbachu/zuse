# ADR 0020 — Pluggable rerank and embed providers

Date: 2026-05-06
Status: Accepted

## Context

The index needs an embedding model (Tier 3 vector search) and a rerank
model (Tier 3 final ranking). Both have meaningful trade-offs along
quality / speed / cost / privacy axes:

- **Local default** (free, private, but quality is below SOTA)
- **Voyage / Cohere / OpenAI** (paid, SOTA quality, requires API key,
  chunks leave the user's machine)
- **Memoize-cloud** (deferred — see ADR 0021)

Different users have different needs. A solo developer indexing a
private repo wants local-only. A team OK with sharing chunks with
Voyage wants SOTA quality. A curious user wants to A/B compare. The
architecture has to make the choice user-configurable without entangling
the engine's internals.

## Decision

Define two **provider abstractions** in `@zuse/index` —
`EmbeddingProvider` and `RerankProvider` — and ship multiple
implementations. The user picks via config (env var or
`memoize-index.config.json` in the workspace).

### EmbeddingProvider contract

```ts
// packages/index/src/embedding/api.ts
export interface EmbeddingProvider {
  readonly id: string                          // "nomic-local", "voyage", ...
  readonly model: string                        // "nomic-embed-code", "voyage-code-3", ...
  readonly dim: number                          // 768, 1024, ...
  embedBatch(
    texts: ReadonlyArray<string>
  ): Effect<ReadonlyArray<Float32Array>, EmbeddingError>
}
```

### RerankProvider contract

```ts
// packages/index/src/retrieval/rerank.ts
export interface RerankProvider {
  readonly id: string                          // "bge-local", "voyage", ...
  readonly model: string
  rerank(
    query: string,
    chunks: ReadonlyArray<{ id: number; text: string }>
  ): Effect<ReadonlyArray<{ id: number; score: number }>, RerankError>
}
```

### Implementations shipped in 0.04

Embedding:

| Provider | Implementation | Default? |
|---|---|---|
| `nomic-local` | `@huggingface/transformers` ONNX runtime, `nomic-ai/nomic-embed-code` | **yes** |
| `voyage` | HTTP client → Voyage API, `voyage-code-3` | opt-in |
| `openai` | HTTP client → OpenAI Embeddings API, `text-embedding-3-large` | opt-in |
| `jina` | HTTP client → Jina API (or local `jina-code-v2` ONNX) | opt-in |

Rerank:

| Provider | Implementation | Default? |
|---|---|---|
| `bge-local` | `@huggingface/transformers` ONNX, `BAAI/bge-reranker-v2-m3` | **yes** |
| `voyage` | HTTP client → Voyage rerank-2 | opt-in |
| `cohere` | HTTP client → Cohere rerank-3 | opt-in |
| `none` | identity function (skip rerank) | for benchmarks |

### Provider switching

The active provider is selected by the engine at startup:

```ts
// pseudo-config
{
  "embed": "nomic-local",   // or "voyage" | "openai" | "jina"
  "rerank": "bge-local"     // or "voyage" | "cohere" | "none"
}
```

If the embed provider changes (different `dim`), the engine throws on
boot — `embedding_meta.dim` will mismatch the existing `vec0` schema.
The user is shown a clear error: "Re-index required to switch embed
model." Rerank can be swapped freely (no persistent state).

### Credential storage

API-based providers read keys from `keytar` (in `apps/server`) or env
vars (in `apps/mcp-server`). The provider abstraction never touches
keytar directly — `apps/server`'s `IndexService` injects env into the
provider when constructing the engine. See ADR 0021.

### Bundled model weights

`nomic-embed-code` (~280MB ONNX) and `bge-reranker-v2-m3` (~120MB ONNX)
weights ship inside the desktop app bundle. First-run extraction; no
network call. For the `apps/mcp-server` standalone binary, weights
either bundle in (Bun supports embedding files at compile time) or
download on first use (configurable).

## Consequences

### Positive

- Users choose between privacy (local) and quality (paid) without
  modifying engine code.
- Adding a new provider (Cohere, Mistral, a future memoize-cloud) is
  a new file, not a refactor.
- Benchmarking is straightforward — swap providers and re-run the eval.
- The provider boundary contains all network code, all credential
  reads, all error mapping. The engine stays clean.

### Negative

- Bundled local models add ~400MB to the desktop install. Documented;
  on disk, not in RAM until first use.
- Each provider has its own error model (rate limits, auth failures,
  network errors). The abstraction maps these into our `EmbeddingError`
  / `RerankError` taxonomy, but the cases proliferate.
- Different embed models have different optimal context windows; we
  truncate to the smaller of the model's context and our chunk size.

## Alternatives considered

### Hardcode one embed + one rerank

- Pro: simpler.
- Con: forecloses BYOK and cloud. The whole pricing-strategy
  conversation (ADR 0021) becomes much harder if every user has the
  same provider.

### Provider as a compile-time decision

- Pro: smaller install if you only want one.
- Con: can't switch without rebuilding. Bad for users who experiment.

### Make every chunk's embedding a Promise resolved by whoever calls
search

- Pro: total flexibility.
- Con: every search becomes its own embed operation. Defeats the
  caching benefit of pre-embedding chunks.

## What we deliberately rejected

- Mix-and-match per-query providers. One workspace, one embed model,
  one rerank model.
- Memoize-managed key escrow in 0.04. ADR 0021 defers this.
- Streaming embeddings. Embeddings are batch in nature; streaming
  doesn't help our async-worker model.

## Reference

The provider pattern matches the agent integration adapter pattern
(`AgentAdapter` in `0.01-MVP/features/agent-integration.md`): one
contract, multiple implementations, swappable at runtime.
