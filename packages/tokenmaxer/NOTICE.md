# Tokenmaxer Notices

Tokenmaxer reads local coding-agent usage data in the same spirit as ccusage.

The per-source parsers (Claude Code, Codex, OpenCode, Amp, pi-agent), the
deduplication rules, the LiteLLM pricing model (fetch + cache + offline
snapshot, exact → provider-prefix → fuzzy model matching, 200k tiered pricing,
`auto` cost mode), and several source names are adapted from ccusage, which is
MIT licensed:

https://github.com/ccusage/ccusage

Specifically:
- Claude Code: `message.usage` JSONL schema with `message.id[:requestId]`
  deduplication (larger-token-total wins on collision).
- Codex: `token_count` events preferring per-turn `last_token_usage`, otherwise
  subtracting the running cumulative `total_token_usage` to avoid double counting.
- Pricing data: `model_prices_and_context_window.json` from BerriAI/LiteLLM.

`data/litellm-prices.json` is a filtered offline snapshot of the LiteLLM pricing
dataset (BerriAI/LiteLLM, MIT) used as a fallback when the network is
unavailable or `--offline` is passed.

Memoize's own SQLite usage rows remain a first-class source. The implementation
is plain TypeScript (no worker threads / valibot), independent of ccusage's code.
