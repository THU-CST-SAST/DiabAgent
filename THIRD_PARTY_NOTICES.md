# Third-Party Components

The repository's original code is MIT-licensed (LICENSE). This does not relicense external material.

| Component | Source / Terms |
|---|---|
| Deichmann2023 physiological reference | `sim/vendor/deichmann2023/LICENSE`, BSD-3-Clause; source/provenance retained beside the reference implementation and `sim/model/Deichmann2023.ts` |
| oref0 components | `sim/vendor/oref0/LICENSE.txt`, MIT; upstream OpenAPS attribution retained |
| Codex model catalog | Derived from OpenAI Codex `83086188ae0614bd882818ff1aa23f3194962012`; `harnesses/codex-decision-loop/UPSTREAM-LICENSE` (Apache-2.0), UPSTREAM-NOTICE and CATALOG-PROVENANCE.json retained. Custom model capability templates are derived locally by `catalog.mjs`; the original catalog is retained. |
| npm packages | Exact versions/integrities in `sim/package-lock.json`; individual package licenses apply |
| External glucose-management Skill | Git submodule `THU-CST-SAST/sweet-agent-skill`, commit `eb62199ff01267b49a833d493fd91c57bd8fe150`; its own attribution and redistribution terms apply, including underlying reference material |

The external Skill is a separately fetched dependency, not relicensed as DiabAgent MIT code. Setup uses only pinned Markdown and repository-authored derivation rules, not its App/DSH or real-device runtime. The derived directory is ignored by Git. No OCR transcript, textbook PDF, full-text QA library or reconstructed volunteer records have been copied into this repository's Git objects. A submodule reference does not grant additional rights to redistribute its underlying sources; review upstream terms before redistributing derived materials.

Official Claude Code and Codex binaries and model service credentials are not distributed. Their installation, access, and service terms are separate from this source release.
