# Third-party notices / 第三方声明

The following skills under `omp/agent/skills/` (and their copies installed by the harness) are derived from third-party projects. Each directory carries the upstream license text. Local copies may be older than upstream and contain local edits (routing text, trimmed or reorganized references); the upstream commit noted below is the version used to confirm the license, not necessarily the exact version copied.

以下技能来自第三方项目，各目录内附上游许可证原文。本地副本可能比上游旧，并有本地改动（路由说明、删减/重组的参考文档）。

| Skill | Upstream | License | Copyright | License file(s) | Upstream commit checked |
|---|---|---|---|---|---|
| `cloudbase` | https://github.com/TencentCloudBase/skills | MIT | (c) 2025 Tencent CloudBase | `omp/agent/skills/cloudbase/LICENSE` | `c8cbfe5` |
| `baoyu-design` | https://github.com/JimLiu/baoyu-design | MIT | (c) 2026 Jim Liu 宝玉 | `omp/agent/skills/baoyu-design/LICENSE` (+ vendored PptxGenJS MIT license in `agents/gen-pptx/vendor/pptxgenjs/LICENSE`; vendored `agents/vendor/` React 18.3.1, @babel/standalone and fflate builds are MIT) | `6530033` |
| `emil-design-eng` | https://github.com/emilkowalski/skills | MIT | (c) 2026 Emil Kowalski | `omp/agent/skills/emil-design-eng/LICENSE` | `e8a175d` |
| `fixing-accessibility` | https://github.com/ibelick/ui-skills | MIT | (c) 2026 Julien Thibeaut | `omp/agent/skills/fixing-accessibility/LICENSE` | `61db890` |
| `fixing-motion-performance` | https://github.com/ibelick/ui-skills | MIT | (c) 2026 Julien Thibeaut | `omp/agent/skills/fixing-motion-performance/LICENSE` | `61db890` |
| `caveman` | https://github.com/JuliusBrussee/caveman | Apache-2.0 (3.0.0+); the skill was MIT before 3.0.0 | (c) 2026 Julius Brussee | `omp/agent/skills/caveman/LICENSE`, `LICENSE-MIT`, `NOTICE` | `2e08b91` |
| `matt` | Routes to https://github.com/mattpocock/skills (upstream skill files are **not** shipped; the router text is local) | MIT | (c) 2026 Matt Pocock | `omp/agent/skills/matt/LICENSE`, `packages/skills/omp-skill-matt/skills/matt/LICENSE` | `49dd158` |

Skills that already shipped their own license before this snapshot:

| Skill | License | File |
|---|---|---|
| `archify` | MIT, (c) 2026 tt-a1i / (c) 2025 Cocoon AI | `omp/agent/skills/archify/LICENSE` |
| `frontend-design` | Apache-2.0 | `omp/agent/skills/frontend-design/LICENSE.txt` |
| `shadcn` | MIT, (c) 2023 shadcn | `omp/agent/skills/shadcn/LICENSE.md` |
| `ponytail` | MIT (declared in `SKILL.md` front matter) | `omp/agent/skills/ponytail/SKILL.md` |
| `pm` review methods: `bmad` (MIT, BMad Code, LLC), `pm-critic` (Apache-2.0, Jonathan Prisant) | | `omp/agent/skills/pm/references/review-methods/*/LICENSE` |

## Excluded from the MIT license / 不适用 MIT 许可的目录

| Path | Status |
|---|---|
| `omp/agent/skills/ui-ux-design-audit/`, `packages/skills/omp-skill-ui-ux-design-audit/` | `SKILL.md` is an independent rewrite inspired by third-party material of unknown origin and license. The original text is no longer distributed. These directories are **excluded from the root MIT license** until provenance is confirmed; see `SOURCE.md` in the skill directory. / `SKILL.md` 为独立重写，参考过来源与许可均不明的第三方材料；原文已不再分发。在来源确认前，这两个目录**不适用根目录 MIT 许可**，详见技能目录内的 `SOURCE.md`。 |

Runtime dependencies that are installed at install time and not vendored here: `@oh-my-pi/pi-coding-agent` (OMP), `@timiliang/pi-quotas`.
