# Zuse pre-publication SEO audit

Date: 2026-09-17. Scope: current workspace source for `apps/web` and `apps/docs`; marketing canonical origin `https://zuse.sh`, documentation origin `https://docs.zuse.sh`.

## Result and limits

**The requested suite is installed and has run against the current local previews.** This is a bounded pre-publication audit, not a production search-performance score. The [claude-seo suite](https://github.com/AgriciDaniel/claude-seo) lives in `.context/claude-seo`; its `seo`, `seo-audit`, `seo-technical`, and `seo-sitemap` skills informed this review.

The initial doctor reported missing Python 3.10+. After the user explicitly authorized setup, Python 3.11 was installed and the suite created its own isolated runtime. Doctor now reports `ready: true`, `browser_ready: true`, plugin version `2.3.1`. No global Python packages were installed.

### Automated results

| Check | Result | Evidence |
| --- | --- | --- |
| Runtime doctor | Core and Chromium ready | `data/runtime.json` |
| Sitemap discovery, marketing and docs | Both local `/sitemap.xml` routes return HTTP 200, valid URL sets, no warnings | `data/web-sitemap.json`, `data/docs-sitemap.json` |
| Raw fetch and HTML analysis | 9 representative pages return 200 with one H1, canonical and readable primary content | `data/web*.json`, `data/docs-start.json` |
| Homepage rendering detection | Auto selected raw HTML; `is_spa: false` | `data/render-local.json` |
| Article structured data extraction | All 3 new articles contain BlogPosting and BreadcrumbList | Article `data/web*.json` |
| Metadata-template analysis | 0/9 descriptions classed as templated; low site risk | `data/metadata-analysis.json` |
| Content-quality heuristic | 74/100 for workspace choice, 71/100 each for parallel agents and review; no filler/AI-pattern matches | `data/content*.json` |
| Claims heuristic | No matching statistical/quantified claim patterns in 3 new articles | `data/verify*.json` |
| Google credentials | None configured | `data/google-auth.txt` |

The nine fetched pages are `/`, `/blog`, `/pricing`, `/changelog`, `/developers`, all three new Dispatch articles, and docs `/start`. All three article pages expose their full main content and schema in initial HTML. The two low metadata flags only object to the normal word “Zuse” in written pricing/changelog sentences, so they are false positives. Two articles get a low-density heuristic flag: treat this as a prompt for editorial review, not proof of low usefulness. Claims-pattern scanning is not fact checking.

No production performance, rankings, Search Console indexation, backlinks or AI citation rates were measured. Google APIs have no credentials. Local developer-server timings would not be a credible production CWV baseline. The suite's auto render used raw HTML, not a rendered-browser accessibility pass; browser visual checks are handled by the main implementation. No numeric overall SEO score is assigned because these categories remain unmeasured.

### Reproduction

```sh
sudo dnf install -y python3.11
export CLAUDE_SEO_PYTHON=/usr/bin/python3.11
export CLAUDE_SEO_LOCAL_TARGETS=localhost:3001,localhost:3002
.context/claude-seo/scripts/claude-seo setup
.context/claude-seo/scripts/claude-seo doctor --json
.context/claude-seo/scripts/claude-seo run google_auth.py --check
.context/claude-seo/scripts/claude-seo run sitemap_discovery.py http://localhost:3001 --json
.context/claude-seo/scripts/claude-seo run sitemap_discovery.py http://localhost:3002 --json
.context/claude-seo/scripts/claude-seo run fetch_page.py http://localhost:3001/blog/choose-where-agents-run --output .context/seo-html/choose-where-agents-run.html
.context/claude-seo/scripts/claude-seo run parse_html.py .context/seo-html/choose-where-agents-run.html --url http://localhost:3001/blog/choose-where-agents-run --json
.context/claude-seo/scripts/claude-seo run render_page.py http://localhost:3001 --mode auto --json
.context/claude-seo/scripts/claude-seo run metadata_template.py --pairs-file internal-docs/seo/zuse.sh-audit/data/metadata-pairs.json --json
.context/claude-seo/scripts/claude-seo run content_quality.py apps/web/content/blog/choose-where-agents-run.mdx --json
.context/claude-seo/scripts/claude-seo run content_verify.py apps/web/content/blog/choose-where-agents-run.mdx --json
```

Fetch/parse were repeated for the nine routes above, and content checks for all three new MDX files. Initial requests were interrupted by development servers exiting; all selected fetches succeeded after restart. Large raw HTML is retained only in gitignored `.context/seo-html`; structured evidence is stored with this report.

## Observed strengths

- Next.js public routes and Fumadocs MDX collections provide server-renderable primary content. Article paths are generated from the collection.
- `apps/web/lib/seo.ts` centralizes title, description, canonical, Open Graph, Twitter, and indexing metadata. Localized landing routes share hreflang alternates.
- Marketing robots allows public crawling and excludes `/api/`. Documentation has a matching metadata-route implementation.
- Homepage JSON-LD already describes the organization, website, and software, with repository, license and free-download information. Do not imply hosted cloud usage is free merely because desktop software has a zero-price offer.
- Documentation has generated `/llms.txt`, `/llms-full.txt`, Markdown endpoints, related links, prerequisites, and source links. These are useful machine-readable discovery surfaces; they are not proof of search indexing or citations.
- Current dither illustrations are small WebP assets (roughly 16–20 KB for the inspected pegasus and observatory variants). Decorative images use empty alt text. Preserve semantic text outside canvas effects.

## Findings and changes

| Priority | Finding and evidence | Disposition |
| --- | --- | --- |
| High | Marketing sitemap listed `/blog` but omitted every article, making article discovery depend entirely on links. | Fixed: sitemap derives article URLs from the same `blog.getPages()` source as routes and index; includes new `/pricing`. Regression test covers collection discovery. |
| Medium | Every sitemap URL used the request/build time as `lastModified`, unrelated to significant page edits. | Fixed: omitted modification dates until the content model maintains trustworthy revision dates. Removed unnecessary priority/change-frequency hints. |
| High | Docs had both `public/robots.txt` declaring `/sitemap-index.xml` and `src/app/robots.ts` declaring `/sitemap.xml`. | Fixed by main implementation: stale file removed; suite confirms docs robots points to valid `/sitemap.xml`. |
| Medium | Existing article route returned generic website social metadata and lacked article JSON-LD at audit start. | Fixed in shared article template; all three new articles verified with BlogPosting and BreadcrumbList in raw HTML, with article Open Graph metadata in source. |
| Medium | Original MDX bodies repeated the heading already rendered by BlogHeader. | Fixed across MDX source; HTML parser confirms exactly one H1 for each new article. |
| Medium | Existing local-first articles describe a desktop data path; new marketing emphasizes optional cloud execution. | Review historical claims in context. Clearly distinguish local desktop storage, hosted provider requests, remote machines, and optional cloud workspaces. No invented feature availability or security guarantees. |
| Medium | Fonts and animated dither introduce potential layout shift and rendering cost; a source audit cannot establish their real impact. | Measure production-build LCP, INP and CLS, including mobile and reduced-motion behavior, before claiming performance success. |
| Medium | Production sitemap discovery follows `https://zuse.sh/sitemap.xml` to `https://www.zuse.sh/sitemap.xml`, while local default canonicals use the apex. | Verify deployment `NEXT_PUBLIC_SITE_URL` and choose one canonical origin consistently. Do not change domain policy implicitly during a visual redesign. |
| Low | Some social preview art is SVG. Browser display support does not establish support by social card scrapers. | Fixed in article metadata: SVG previews now use the common raster `/og.png` for social cards. New articles use WebP. Test share previews after deployment. |

## Content and search experience

The primary intent is a developer evaluating an open-source coding-agent workspace, with both local and cloud workflows. The landing page should answer what Zuse does and where agents run; pricing should answer what is free, what is beta, and which usage costs belong to external providers. Dispatch serves educational and product-information intent. Documentation serves concrete setup and task completion.

Preserve the requested concise visual brand. The suite's generic word-count gates are editorial heuristics, not a reason to pad pages. Articles should include reproducible steps, specific limitations, useful internal links and accurate author/publication details. Avoid unsupported competitor superiority claims, invented benchmarks, fabricated customer quotes, or keyword-heavy filler.

The proposed cluster is coherent: open-source cloud agents, parallel agents with worktree isolation, and local versus cloud execution. Link each article to the relevant documentation, pricing explanation and related Dispatch article. Use headings that answer concrete reader questions. An article's value comes from practical details and accurate claims, not merely its length.

## AI discovery and schema

Existing robots rules do not distinguish search crawlers from training crawlers. That is a policy choice, not an SEO defect. No change to crawler policy is necessary for this redesign. Keep public answers readable in HTML and preserve docs Markdown exports. Marketing also has `/llms.txt` and homepage Markdown routes. These machine-readable exports should not be sold as ranking requirements.

Use truthful BlogPosting data from each MDX record: headline, description, publication date, author, canonical mainEntityOfPage, publisher and an actual image URL. Do not invent last-updated dates. Do not add FAQ/HowTo markup purely to chase rich results. The suite parser successfully extracted article JSON-LD from the new pages. Google rich-results eligibility and indexing remain separate deployment checks.

## Verification performed for owned fixes

- `bunx biome check --write apps/web/app/sitemap.ts apps/web/app/sitemap.test.ts`: passes after formatting.
- `bun run --filter web test -- app/sitemap.test.ts`: 2 tests pass.
- `bun run --filter web check-types`: passes.
- `bun run --filter web test`: all 59 tests in 10 files pass. Added shared Vitest fixture deriving article URLs from real MDX filenames because the Next-only `collections/server` virtual module is unavailable in unit tests. Existing legal/locale sitemap assertions remain intact.

## Next audit

After the redesign is deployed, verify robots and every sitemap URL, raw/rendered canonical parity, one article H1, article schema, social previews, internal links and mobile content parity. Run production lab performance measurements and collect field data when available. Monitor Search Console discovery/indexation for the new articles and `/pricing`; treat impressions and useful visits as outcomes, not a guaranteed consequence of markup changes. See [ACTION-PLAN.md](./ACTION-PLAN.md) for sequence and failure checks.

## Final implementation validation

- Web: 59 unit/behavior tests pass; TypeScript passes.
- Docs: TypeScript and internal links across 81 routes pass.
- Docs Playwright: 21 pass, 5 deliberate platform-specific skips. Two cold-dev-server search timeouts passed on retry and on the full warmed run.
- Biome checks pass across 47 changed web/docs source files; subsequent article edits checked separately.
- Desktop and mobile screenshots reviewed for docs, Dispatch index/articles, and pricing.

## Product offering correction

After the audit, the product owner clarified that Persistent Standard is not
an offered plan. It has been removed from pricing, metadata, and the workspace
guide. Public pricing now lists only Local and Cloud Workspace. JSON evidence
in `data/` is a historical capture from before this correction, not current
product pricing. Internal billing catalog entries do not establish availability.
