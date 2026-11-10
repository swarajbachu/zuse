# Mobile 1.1.0 store asset production checklist

Verified against Apple documentation on 2026-10-24. All 30 delivery PNGs are rendered and validated, using 24 simulator captures and six creative compositions.

## Current production state

- Completed: 24 device-framed screenshot cards and six header/search/universal masters. `apps/mobile/store-assets/1.1.0/delivery/manifest.json` records exact dimensions and bytes; all 30 are opaque PNGs.
- All devices stay inside the horizontal canvas bounds: portrait cards allow 96% width, landscape devices occupy at most 60% width starting at 36%, and creative devices are capped at 50% width around the 70% horizontal center. Approximately 10% of each device extends below the canvas. The renderer rejects horizontal overflow. Smaller headlines, removed accent rules, and subdued illustration backgrounds make the app more prominent.
- Captures use the Expo app with isolated sample projects and official Apple device bezels. Generated illustration backgrounds are stored under `source/`. No private chats appear in the artwork.
- Xcode 27.1 and the iOS 27.1 simulator runtime are installed. iPad and Duo simulators were opened for native captures. Both Duo displays have portrait and landscape coverage.
- Fixed the Uniwind asset-registry startup failure, bounded-sheet padding, iOS rotation policy, and horizontal safe-area handling. The final review screen is included in the captures.
- Mobile validation: 520 tests across 108 files, both TypeScript projects, and applicable Biome checks passed.
- Production build 17 finished from source commit `a33fc7cba`, including review commit `01d03e501`; Apple reports build 17 VALID. Code-signature verification passed, with build number 17 and Xcode 27.1 in the signed archive. The release draft selects build 17. Apple rejected adding the app version to review because `usesNonExemptEncryption` is unanswered; the owner must confirm the declaration. This is not evidence of App Review approval or public release.
- App Store Connect's public OpenAPI omitted Duo at this check; its live API explicitly supports `APP_IPHONE_DUO`. Eight revised iPad and ten revised Duo screenshots are selected in the draft. Processing is checked separately for each revised upload. Portrait cards lead each set; the Duo set includes both displays plus two inner-display landscape examples. All 30 files are also uploaded to the asset library. The new iPad header and search placements are selected on the draft. Apple is processing the replacements; remaining creative masters must finish processing before they can be attached to the prepared review submission.

## Render commands

Run `node apps/mobile/scripts/render-store-assets.cjs` from the repository root after capturing all 24 sources into `.context/mobile-release/captures`. Missing captures fail the complete-pack render. Supply licensed Apple PNG bezels under `.context/mobile-release/bezels`.

For an explicitly partial preview, use `node apps/mobile/scripts/render-store-assets.cjs --surface=ipad --available`. On macOS, set `FONTCONFIG_FILE=/opt/homebrew/etc/fonts/fonts.conf` if the image renderer cannot locate its font configuration. The default font is Helvetica Neue Bold. Re-run the complete-pack command before delivery; it requires exactly 30 opaque PNGs.

## Scope and counts

- 24 screenshot cards: four real app scenes × two orientations × three display surfaces. Each card places an actual capture inside the matching Apple device bezel, with a short headline and the existing lime/black visual style.
- Six creative masters: two device-led concepts, each with a legacy header, legacy search image, and one universal image shared by both placements.
- Total: 30 new delivery images per locale, plus 24 unframed source captures retained as working files. Existing standard iPhone assets and the existing app icon are separate.
- The two existing illustration drafts can supply creative backgrounds; they do not replace the feature screenshots.

## Apple minimums versus the requested pack

Apple requires at least one screenshot for a supported required display size and allows up to 10 per device size. iPad requires the 13-inch size. Both orientations and four scenes are our requested production coverage, not a claim that Apple requires every variant. Eight screenshot cards per display surface fit within the 10-image limit. Duo screenshots are currently optional; Apple specifies a requirement starting April 2027 for apps built with the iOS 27.1 SDK or later.

Creative assets and device-led concept variants are additional marketing coverage. Header and search placements are not inherently separate per hardware model; select one default concept per placement and retain the other for an alternate/custom page or optimization treatment. A universal 5244 × 2950 PNG can serve both placements.

## Screenshot card inventory

| # | Delivery filename | Pixels | Scene |
|---|---|---|---|
| 01 | `ipad-portrait-01-projects.png` | 2064 × 2752 | iPad 13-inch: Every project. One place. |
| 02 | `ipad-portrait-02-conversation.png` | 2064 × 2752 | iPad 13-inch: Keep the conversation moving. |
| 03 | `ipad-portrait-03-start-work.png` | 2064 × 2752 | iPad 13-inch: Start your next task. |
| 04 | `ipad-portrait-04-review-changes.png` | 2064 × 2752 | iPad 13-inch: Review every change. |
| 05 | `ipad-landscape-01-projects.png` | 2752 × 2064 | iPad 13-inch: Every project. One place. |
| 06 | `ipad-landscape-02-conversation.png` | 2752 × 2064 | iPad 13-inch: Keep the conversation moving. |
| 07 | `ipad-landscape-03-start-work.png` | 2752 × 2064 | iPad 13-inch: Start your next task. |
| 08 | `ipad-landscape-04-review-changes.png` | 2752 × 2064 | iPad 13-inch: Review every change. |
| 09 | `duo-outer-portrait-01-projects.png` | 1398 × 2034 | iPhone Duo outer display: Every project. One place. |
| 10 | `duo-outer-portrait-02-conversation.png` | 1398 × 2034 | iPhone Duo outer display: Keep the conversation moving. |
| 11 | `duo-outer-portrait-03-start-work.png` | 1398 × 2034 | iPhone Duo outer display: Start your next task. |
| 12 | `duo-outer-portrait-04-review-changes.png` | 1398 × 2034 | iPhone Duo outer display: Review every change. |
| 13 | `duo-outer-landscape-01-projects.png` | 2034 × 1398 | iPhone Duo outer display: Every project. One place. |
| 14 | `duo-outer-landscape-02-conversation.png` | 2034 × 1398 | iPhone Duo outer display: Keep the conversation moving. |
| 15 | `duo-outer-landscape-03-start-work.png` | 2034 × 1398 | iPhone Duo outer display: Start your next task. |
| 16 | `duo-outer-landscape-04-review-changes.png` | 2034 × 1398 | iPhone Duo outer display: Review every change. |
| 17 | `duo-inner-portrait-01-projects.png` | 2007 × 2853 | iPhone Duo inner display: Every project. One place. |
| 18 | `duo-inner-portrait-02-conversation.png` | 2007 × 2853 | iPhone Duo inner display: Keep the conversation moving. |
| 19 | `duo-inner-portrait-03-start-work.png` | 2007 × 2853 | iPhone Duo inner display: Start your next task. |
| 20 | `duo-inner-portrait-04-review-changes.png` | 2007 × 2853 | iPhone Duo inner display: Review every change. |
| 21 | `duo-inner-landscape-01-projects.png` | 2853 × 2007 | iPhone Duo inner display: Every project. One place. |
| 22 | `duo-inner-landscape-02-conversation.png` | 2853 × 2007 | iPhone Duo inner display: Keep the conversation moving. |
| 23 | `duo-inner-landscape-03-start-work.png` | 2853 × 2007 | iPhone Duo inner display: Start your next task. |
| 24 | `duo-inner-landscape-04-review-changes.png` | 2853 × 2007 | iPhone Duo inner display: Review every change. |

## Four feature scenes

- **01-projects: Every project. One place.** Project and chat inbox with realistic sample work.
- **02-conversation: Keep the conversation moving.** An active conversation with readable assistant output and tool activity; show the sidebar in wide layouts.
- **03-start-work: Start your next task.** New-chat flow with project, agent, model, and workspace selection.
- **04-review-changes: Review every change.** The actual changes view with readable file names and a small code diff.

## Header and search inventory

| # | Delivery filename | Pixels | Placement / composition |
|---|---|---|---|
| 25 | `ipad-header.png` | 3840 × 1646 | 21:9 header; iPad with a real split-view app capture. |
| 26 | `ipad-search.png` | 3840 × 2560 | 3:2 search; iPad with a real split-view app capture. |
| 27 | `ipad-universal.png` | 5244 × 2950 | 16:9 universal header/search; iPad with a real split-view app capture. |
| 28 | `duo-header.png` | 3840 × 1646 | 21:9 header; iPhone Duo inner display with a real conversation capture. |
| 29 | `duo-search.png` | 3840 × 2560 | 3:2 search; iPhone Duo inner display with a real conversation capture. |
| 30 | `duo-universal.png` | 5244 × 2950 | 16:9 universal header/search; iPhone Duo inner display with a real conversation capture. |

## Composition and delivery

- Use the official Apple product bezels for the exact iPad and Duo display/pose. Keep device renders accurate and the application interface readable.
- Portrait cards use a large upright device with concise copy above it. Landscape cards emphasize the real wide layout and keep the device dominant. Do not rotate or stretch a portrait capture to manufacture landscape UI.
- Capture the four real app states separately on each display and orientation. Retain session state through resizing, folding, and rotation; verify rail and safe-area placement before calling Duo images ready.
- Header and search images need separate composition/crop checks. Keep the focal device and important copy inside the official template safe areas.
- Export opaque RGB PNGs at exact pixel dimensions. No alpha, accidental transparency, private account data, invented UI, unsupported feature claims, or unfinished features. Terminal, voice, and usage surfaces are disabled in the current release and must not be advertised.
- The existing `apps/mobile/assets/icon.png` is 1024 × 1024 and is already present. An icon redesign is not part of this image request.
- Optional in-app event artwork is outside this release pack unless an actual event is being created: landscape card 1920 × 1080 to 3840 × 2160, portrait detail 1080 × 1920 to 2160 × 3840. App-preview videos are also separate, optional deliverables.

## Capture verification limits

- The separate local capture app uses the same production UI with a sample-data bootstrap. It is not the signed production app; fixture data and capture hooks are not shipped.
- Native pose and rotation controls were used for the capture surfaces. The capture instance temporarily requested portrait for the final portrait composer; this does not prove production fold-state behavior on physical hardware.
- After restoring the production rotation policy in the capture instance, native rotation to landscape and conversation continuity through partially open and closed poses were verified. A physical-device Duo smoke test and Apple review remain separate release checks.

## Primary sources

- [Screenshot dimensions, required sizes, scaling, limits, and Duo deadline](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [Header, search, universal, and event asset specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/creative-assets-specifications)
- [Screenshot content, creative composition, safe areas, universal assets, and templates](https://developer.apple.com/app-store/asset-best-practices/)
- [Official product bezels](https://developer.apple.com/design/resources/#product-bezels)
- [App Review accurate metadata requirements](https://developer.apple.com/app-store/review/guidelines/#accurate-metadata)
