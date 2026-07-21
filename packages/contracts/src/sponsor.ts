import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

/**
 * Targeting category for a sponsor serve. Mirrors the ADtention SDK's category
 * taxonomy. The renderer classifies the user's latest prompt on-device and
 * sends only this tag — never the prompt text — to the server.
 */
export const SponsorCategory = Schema.Literals([
  "web3",
  "web",
  "devops",
  "data",
  "systems",
  "general",
]);
export type SponsorCategory = typeof SponsorCategory.Type;

/**
 * A render-ready sponsor line. `text` is already terminal/HTML-safe (the SDK
 * strips ANSI/control bytes); `clickUrl` is an absolute http(s) URL that 302s
 * through the ad server (and records the click), or `null` when the ad has no
 * destination. This is the slim projection the footer needs — the server keeps
 * `adId`/`impressionId`/billing fields to itself.
 */
export class SponsorLine extends Schema.Class<SponsorLine>("SponsorLine")({
  text: Schema.String,
  clickUrl: Schema.NullOr(Schema.String),
}) {}

/**
 * Fetch the current sponsor line for a category. Serving happens server-side
 * (the ad API sends no CORS headers, and the install's opaque subject id lives
 * on the server) — the renderer only passes the category tag and renders the
 * result. Returns `null` on no-fill or any transient error; the server never
 * surfaces a failure here.
 */
export const SponsorNextRpc = Rpc.make("sponsor.next", {
  payload: Schema.Struct({ category: SponsorCategory }),
  success: Schema.NullOr(SponsorLine),
});
