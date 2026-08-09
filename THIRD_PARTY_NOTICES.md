# Attribution and provenance

Zuse was developed as an independent repository rather than as a GitHub fork.
Its history does, however, record deliberate study of an upstream open-source
desktop-agent project. This file distinguishes ideas and behavioral references
from code-level similarities and third-party library use. Whether a repository
uses GitHub's fork mechanism does not determine whether a license notice is
needed; copied or adapted code does.

## Reference-driven pull requests

These pull requests explicitly recorded the upstream project as a design or
behavioral reference. Listing a pull request here does not mean its code was
copied; it records where comparison influenced a decision:

| Pull request | Recorded influence |
| --- | --- |
| [#1](https://github.com/swarajbachu/zuse/pull/1) | Initial Electron main/renderer split and desktop build orchestration. |
| [#10](https://github.com/swarajbachu/zuse/pull/10) | Documentation-only server and domain-layout decision intended to make architectures easy to compare. |
| [#19](https://github.com/swarajbachu/zuse/pull/19) | Chat-first shell, inline model picker, and selected layout behavior. |
| [#71](https://github.com/swarajbachu/zuse/pull/71) | Keybinding parser structure and settings interaction patterns; persistence and implementation remain project-specific. |
| [#72](https://github.com/swarajbachu/zuse/pull/72) | Per-model capability descriptors used as a product/API pattern. |
| [#111](https://github.com/swarajbachu/zuse/pull/111) | Model catalog, aliases, and capability presentation were cross-checked for feature parity. |

[PR #79](https://github.com/swarajbachu/zuse/pull/79) separately records a
deliberate move to a custom diff presentation so the product would have its own
visual language.

## Small code-level similarities

Two small areas have close code-level correspondence with MIT-licensed upstream
software:

- the initial form of `apps/desktop/tsdown.config.ts`, which has since evolved;
- `apps/renderer/src/lib/chat-list-anchor.ts`, a small anchor-resolution utility.

The MIT notice below is retained conservatively for the two areas above. It does
not make Zuse's original code MIT-licensed, and it does not imply that the
repository as a whole was copied or forked.

## Library and framework foundations

The project also builds directly on public libraries and component registries:

- Effect and `@effect/*` provide the service, schema, streaming, and RPC model;
  [PR #3](https://github.com/swarajbachu/zuse/pull/3) records the official
  Effect protocol as the implementation reference;
- shadcn/ui, Base UI, and configured component registries provide UI primitives
  that are generated and then maintained in this repository;
- the public icon data package and its React and React Native renderers provide
  the default contributor icon set; licensed release builds may use separately
  installed paid icon data governed by its own license terms;
- CodeMirror, xterm.js, and the Pierre packages provide editor, terminal, diff,
  and tree foundations;
- Next.js and Fumadocs provide the documentation application.

These are dependencies or generated upstream primitives, not evidence of code
copied from the reference project. Their own packages and licenses remain the
authoritative terms. Package-specific adaptations are documented separately;
for example, see [`packages/tokenmaxer/NOTICE.md`](packages/tokenmaxer/NOTICE.md).

## Preserved upstream MIT license

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
