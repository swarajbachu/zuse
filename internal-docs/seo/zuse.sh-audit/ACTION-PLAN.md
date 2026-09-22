# SEO action plan

| Order | Action | Dependency | Failure check | Leading indicator |
| --- | --- | --- | --- | --- |
| 1 | Completed: shared article metadata/schema and conflicting docs public robots cleanup. | Current redesign. | Final raw HTML lacks canonical/article data, or `/robots.txt` fails or declares a missing sitemap. | Successful route responses and valid schema. |
| 2 | Verify all sitemap URLs and canonical targets in the production preview. | New pricing and MDX routes exist. | Any URL redirects, returns non-200, or carries noindex. | Complete canonical URL coverage. |
| 3 | Review new and historical product claims for local/cloud distinctions; add useful docs links. | Editorial content ready. | Instructions cannot be followed or claim functionality not available. | Successful task walkthroughs and fewer dead-end article visits. |
| 4 | Completed after explicit authorization: isolated runtime setup and bounded suite audit. Expand to production crawl. | Python 3.10+ and isolated runtime available. | Doctor remains unready or suite cannot crawl the selected public target. | Crawl artifacts and validated sitemap/schema reports. |
| 5 | Measure production-build desktop/mobile performance and validate social cards. | Stable deployment preview. | LCP/INP/CLS regress or social image fails to render. | Real measured performance and successful preview fetches. |
| 6 | Submit/verify sitemaps in Search Console and monitor new routes. | Deployment and account access. | Pages remain undiscovered or canonicalized elsewhere. | Indexed routes, relevant impressions and visits over time. |

No rankings, traffic lift, backlink authority, or AI citation outcome was measured or promised. PDF report generation is available via the installed suite; it was not run because the deliverable is a source-controlled Markdown report with JSON evidence.

Deployment follow-up: verify whether `www.zuse.sh` is the intended canonical origin. Production redirects apex sitemap requests to `www`, while local metadata defaults to the apex.
