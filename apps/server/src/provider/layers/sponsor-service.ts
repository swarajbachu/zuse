import { SponsorSlot } from "@adtention/sdk";
import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SponsorLine } from "@zuse/contracts";

import { AppPaths } from "../../app-paths.ts";
import {
  SponsorService,
  type SponsorServiceShape,
} from "../services/sponsor-service.ts";

// Public ADtention publisher id (the earning account). Hardcoded on purpose:
// Zuse ships as a downloadable desktop app, so there is no server-side runtime
// env on the user's machine — the public id must be baked into the build for
// any ad to serve ("project earns"). The id is public and safe to commit; only
// the private `secret` (payout, managed in the portal) must stay out of the
// repo. `ADTENTION_PUBLISHER_ID` overrides it for dev/forks.
const DEFAULT_PUBLISHER_ID = "pub_5a09c7c6fdf06b0e";

const resolvePublisherId = (): string | null => {
  const fromEnv = process.env.ADTENTION_PUBLISHER_ID;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return DEFAULT_PUBLISHER_ID.length > 0 ? DEFAULT_PUBLISHER_ID : null;
};

/**
 * Load (or lazily mint) the opaque per-install subject id. PII-free and stable
 * per machine — required so each install is rate-limited independently rather
 * than every install sharing one bucket. Persisted as a plain file under
 * userData; a read/write failure degrades to an ephemeral id rather than
 * breaking serving.
 */
const loadOrCreateSubject = (userData: string): string => {
  const path = join(userData, "adtention-subject");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // not created yet — fall through and mint one
  }
  const fresh = randomUUID();
  try {
    mkdirSync(userData, { recursive: true });
    writeFileSync(path, fresh, "utf8");
  } catch {
    // best-effort persistence; an in-memory id still works for this run
  }
  return fresh;
};

export const SponsorServiceLive = Layer.effect(
  SponsorService,
  Effect.gen(function* () {
    const paths = yield* AppPaths;
    const publisherId = resolvePublisherId();

    // The publisher id is required for serving, but a missing one must never
    // take down the app — warn loudly and disable serving (fail-closed) so a
    // forgotten env var is obvious in logs without crashing anything.
    if (publisherId === null) {
      // eslint-disable-next-line no-console
      console.warn(
        "[sponsor] ADTENTION_PUBLISHER_ID is not set — sponsor serving is disabled. " +
          "Set it in the runtime env (a portal-provisioned id in production).",
      );
      const next: SponsorServiceShape["next"] = () => Effect.succeed(null);
      return { next } as const;
    }

    const subject = loadOrCreateSubject(paths.userData);
    // Node's global fetch needs no binding here (the "Illegal invocation"
    // browser quirk doesn't apply) and the real https apiBase has no CORS
    // restriction server-side.
    //
    // `serveOnly` locks the embed to serving only — it can never self-register
    // (payout is managed in the ADtention portal). `publisherId` is the
    // fixed/provisioned earning account (resolved above), and a stable opaque
    // `subject` is passed on every `next()` so each install is rate-limited
    // independently. `serveOnly: true` requires a publisherId — guaranteed here
    // since the null branch returned above.
    const slot = new SponsorSlot({ publisherId, serveOnly: true });

    const next: SponsorServiceShape["next"] = (category) =>
      Effect.tryPromise(() => slot.next({ subject, category })).pipe(
        Effect.map((ad) =>
          ad === null
            ? null
            : new SponsorLine({ text: ad.text, clickUrl: ad.clickUrl }),
        ),
        // The SDK already swallows serve errors, but guard the boundary so a
        // thrown rejection can never become an RPC defect.
        Effect.catch(() => Effect.succeed(null)),
      );

    return { next } as const;
  }),
);
