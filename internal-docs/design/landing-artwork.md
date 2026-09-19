# Landing artwork and typography

The workflow uses three original AI-generated illustrations: Pegasus and
celestial orbits, a classical observatory, and sculpted hands passing a sphere.
The original images are retained as `public/brand/{pegasus,observatory,handoff}.webp`.

The displayed `*-dither.webp` variants use a 4×4 Bayer threshold, sampled at
480px and enlarged with nearest-neighbor interpolation to 960px. The palette is
forest #0f1812 and sage #bcd284. This texture is baked into the assets: no per-frame
image processing or additional canvas is required. Next Image serves responsive
versions. Empty alt text marks these as decorative alongside their headings.

Marketing headings use Sagittaire Display throughout the landing page.
Product UI inside the interactive demo retains its application typography.

React Bits Dither remains unchanged upstream. The active workflow tab and
provider section use the shared visibility-aware wrapper at reduced opacity.
Product illustration backdrops use the quieter `IllustrationBackground`.
The interactive demo has a plain background so it represents the desktop UI.

Marketing prose uses Sagittaire Text Regular (TITL 12, weight 400), a static
instance of the same upright specimen below. This includes hero supporting copy,
feature descriptions, and FAQ answers. Compact labels and controls use Rules
or their existing mono/UI fonts.

Regular, non-condensed Rules remains available for compact text. `rules-regular.woff2` is a
static instance of the reference site's `RulesVariable.woff2`, pinned to width
100, weight 400, and slant 0. Pinning the axes avoids loading the full variable
family. Rules is commercial; confirm Zuse’s webfont license before publishing.

Sagittaire Display uses three real cuts: Regular (400) for the main hero and
card titles, Light (300) for section headings, and Extralight Italic (200) for
the green hero accent. No synthetic bold or italic is applied. Body prose uses Sagittaire Text. The local WOFF2 files are static instances at TITL 72 (Display)
of Blaze Type's public specimens:
https://blazetype.eu/fonts/sagittaire/sagittairevariable-wght-titl.woff2
https://blazetype.eu/fonts/sagittaire/sagittairevariable-italic-wght-titl.woff2
Only the required static faces ship, avoiding full variable font downloads.
Sagittaire is also commercial; these specimen sources do not grant a webfont
license. Confirm Zuse's license before publishing, or replace the files with
licensed WOFF2s at `public/brand/sagittaire-display-*.woff2`.

Typography is registered once by `SiteDocument` in `site-typography.css`.
All marketing routes share the Display headings and Rules Regular prose, including blog,
changelog, developer, and legal pages. Landing-specific sizes remain in
`landing/showcase.css`. Navigation, controls, release numbers, code, and the
interactive demo retain their compact UI or mono faces. Workflow tab labels use
the shared `brand-heading` class because their markup is not a heading element.

## Editorial and documentation rollout

The editorial publication is named Journal, retaining `/blog` and existing
article URLs. A shared `PageMasthead` supplies the dither illustration, dotted
divider, mono eyebrow, and display heading for pricing, releases,
and developer resources. Article pages keep a single H1 and include BlogPosting
and breadcrumb JSON-LD. New guides are grounded in the checked-in documentation.

The docs app has matching independently deployed assets in `apps/docs/public/brand`
and a scoped `brand.css`. Its article typography changes without restyling code
blocks, search, navigation, or embedded product diagrams as prose. Existing
search, navigation, Markdown, and accessibility behaviors remain tested.

Cloud pricing was verified against `infra/api/src/cloud-billing.ts` and
`internal-docs/cloud/billing.md`. The public offerings are Local and Cloud
Workspace only. Internal machine offers are not customer-facing plans.
Marketing prices must be updated with future catalog changes. The paid Cloud Workspace option
remains explicitly beta with a booking CTA, not an implied live checkout.

## Readability revision

Reading copy now uses Rules Regular (400) across the website and docs. Sagittaire
Display remains for headings; the experimental Sagittaire Text face is no longer
used for paragraphs. Article text is 16px on mobile and 17px on desktop with a
65ch maximum measure and 1.75 line height. Journal pages disable the decorative
bottom blur. Desktop articles have a sticky side contents list; mobile uses
a native disclosure. Journal categories are explicit MDX metadata (Guide, Note,
News), with a Latest feed and dedicated Guide/Note columns. Existing URLs remain.

Journal uses its own editorial masthead. Notes and older articles are text-led;
legacy neon diagram covers are removed. The remaining mythical dither illustrations
are optional article metadata. Related links prioritize the current category, and
the side contents list highlights the active section through Fumadocs.
