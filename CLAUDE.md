# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language policy

- All reasoning, subagent instructions, and inter-agent communication — in English.
- Final responses to the user — in Russian.

### Spec handling

- Specs (`openspec/`) and docs are written in Russian — requirement modality stays English (SHALL / MUST NOT). Keep it that way when editing them; do NOT translate them.
- Reference requirements by ID (e.g. NTR-1, CONT-4, SHELL-3) instead of paraphrasing. When exact wording matters, quote the Russian text verbatim.
- Before implementing, check the relevant capability spec: `openspec spec show <capability>`.
- Navigate specs lazily with `npm run spec-graph -- <cmd>` (`scripts/spec-graph.mjs`): to quote or check a single foreign requirement use `show <ID>` (one section, not the whole spec), find IDs with `find <text>`, expand the task's context via `refs <ID>`. Before editing a requirement, run `impact <ID>` — it lists what may go stale. The capability you are *changing* you still read whole. The tool sees main specs only, not `changes/` deltas; `spec-graph check` lints the reference graph and is part of the `npm run check` gate.

### Naming

- All code — identifiers, comments, schemas — in English. Commit messages follow the repository's own practice: an English conventional-commit prefix (`feat(camera):`, `spec(editor):`, `test:`) with a Russian subject.
- Anglicisms in specs map to their English originals in code (тик → tick, рендер → render); never invent synonyms. Existing names in `engine/` packages are canonical — follow them.

## The repository

`openspec/` is the spec, `engine/` its working implementation (the `*-ts` packages), `editor/` the content editor built on top of them (capability `editor`, roadmap stage 12), `tools/` the Blender level-design pipeline (capability `blender-pipeline`, roadmap stage 35), `content/` the game content the engine runs, `docs/` the non-normative overview. The npm workspace root is the repository root.

Level design happens in Blender, not in our own editor. `<base>.blend` is paired to a scene by name, Blender's stock glTF exporter writes `<base>.glb` beside it, and the importer `tools/blender-ts` (`@game-mvp/blender-ts`, CLI `npm run import`) rewrites **only** the derived spatial layer — `initial` of the scene config (SER-7, SER-8), `decorations` of the paired presentation document (PRES-2), the terrain asset (TERR-3) and the curvature map (ASSET-7) — leaving every other field byte-for-byte (BLND-2). The pipeline is strictly one-directional, deterministic and atomic (BLND-1, BLND-4, BLND-6), and it writes through `editor/core-ts`'s operation layer and canonical save (BLND-5, ED-29, ED-21) — there is no second implementation of validation, serialization or ordering. The Blender add-on lives in `tools/blender-addon/` (Python, outside the npm workspace and outside the `check` gate) and is the main authoring surface, not the law: the guarantee is the import (BLND-8). glTF is the model format of content — the loader is registered in `assets-ts` by ASSET-3 with the canonical representation of ASSET-5, and MDX stays a historical registry format (BLND-11); the models under `content/visuals/` are still MDX until the manual migration lands. Neither the engine nor the client runtime reads `.blend`/`.glb`, and no test needs Blender (BLND-7); the editor keeps preview and data-driven authoring (systems, schemas, prefabs, the manifest), and its level-design direction is frozen.

Game content lives in `content/` and never inside an engine package (`game-content` CONT-1, enforced by `engine/integration-ts/test/contentBoundary.test.ts`): `content/scenes/`, `content/matches/` are sim documents, each scene may have a paired presentation document beside it (`duel.presentation.json` — decorations, capability `presentation-scene` PRES-1), `content/visuals/` holds the visual manifest, models and textures, and an asset ID is a path from the tree root (ASSET-2). Engine test fixtures are **not** content and stay put — `engine/tests/golden/` and the scenes built inline in `engine/integration-ts/test/fixtures.ts` (CONT-4): an engine baseline goes red from an engine change, not from a designer retuning a number.

## The spec is the source of truth

`openspec/specs/` (30 capabilities, 358 requirements) normatively defines what the engine must be. When implementation and spec diverge, the defect is in the implementation (CORE-3). Normative statements live **only** in the specs — do not duplicate them in docs or code.

- Requirements carry historical IDs (`DET-1`, `NET-15`, `FOW-4`…) in `### Requirement:` headers — preserve them; a new requirement takes the next free number of its prefix.
- Changes go through the OpenSpec workflow: `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, etc. (the `openspec-*` skills in `.claude/skills/`). Do not edit specs outside this process.
- Capability ≠ package. `editor` (roadmap stage 12) lives in two packages outside `engine/`, reaches into four more capabilities' specs (`rendering`, `camera`, `serialization`, `assets`) and brought a fifth into being (`presentation-scene` — the paired presentation document its decorations live in); `pathfinding` is a seam with no algorithm behind it. Which requirements of `editor` have code, which are partial and which were out of the pass — `docs/reviews/2026-08-08-editor-coverage.md` (the historical report plus its 2026-08-09 addendum).
- Spec-writing context and rules — `openspec/config.yaml`.
- Layer overview, roadmap, the mechanism-vs-policy split, open questions — `docs/architecture.md` (alongside `docs/one-pager.md`).
- **Work not yet done is written down, not remembered.** `openspec list` is the live queue of proposed changes; the roadmap table in `docs/architecture.md` says what each stage is for and in what order. A change whose `proposal.md` exists while `specs`/`design`/`tasks` are empty is a deliberate stub — read its `## Notes` and continue with `/opsx:update <name>`.

```sh
openspec list --specs               # list capabilities
openspec spec show netcode          # one spec
openspec validate --specs --strict  # format check
```

## Commands (repository root workspace)

Node >= 22.18. The repository root is the npm workspace; its members are the engine packages (`engine/core-ts`, `engine/net-ts`, `engine/render-ts`, `engine/assets-ts`, `engine/client-ts` — the web client shell (worker hosting + channel, SHELL-1..7), `engine/integration-ts` — the cross-layer integration suite, CLI-9) plus the two editor packages (`editor/core-ts` — the headless authoring layer, `editor/ui-ts` — its DOM interface and web app) and the Blender importer (`tools/blender-ts` — glTF parsing, spatial-layer generation and the `import` CLI; the `tools/blender-addon/` add-on is Python and is **not** a workspace member). A single `npm install` from the root installs everything, and the check-everything gate before pushing is `npm run check` — it is `typecheck && lint && spec-graph check && test`, and running only a subset is how a lint or spec-graph failure reaches the remote:

```sh
npm run check     # from the root: typecheck + lint + test — run this before pushing
npm test          # from the root: tests of all packages
npm run typecheck # from the root: tsc --noEmit of all packages
npm run lint      # from the root: eslint . --max-warnings 0
```

`npm run coverage` (root, `vitest.coverage.config.ts`) is a diagnostic, not a gate: no thresholds, and the percentage is not a goal. Read it as the list of what no test executes — a DSL operator exposed to content but never evaluated, a transport branch no match reaches. Run it package-by-package and it lies: `integration-ts` exercises core/net/render, so only the aggregate run counts.

Per-package commands run from the package directory (or via `npm run <script> -w @game-mvp/<name>` from the root). From `engine/core-ts/`:

```sh
npx vitest run test/physics.test.ts      # one file
npx vitest run -t "test name"            # one test by name
npm run sim -- <scenario.json>           # CLI scenario run (bin/sim.mjs)
npm run golden                           # regenerate golden baselines (UPDATE_GOLDEN=1)
npm run schemas                          # regenerate engine/schemas/*.json (UPDATE_SCHEMAS=1)
```

The editor's web app runs from the root as `npm run dev -w @game-mvp/editor-ui` (Vite; `app/vite.config.ts` serves `content/` as the content tree and adds the tree-listing endpoint the web environment host needs — a `vite build` has neither listing nor write, and says so, ED-12).

The Blender import runs from the root (`tools/blender-ts/bin/import.mjs`):

```sh
npm run import -- <path to .glb|.gltf>              # import the spatial layer of the paired scene
npm run import -- <src.glb> --dry-run               # same checks and same target layer, no write; result as JSON on stdout
npm run import -- <src.glb> --watch                 # re-import on every save of the source (hot-reload, BLND-12)
```

`--root <dir>` overrides the content tree root (default — `content/` beside the working directory), `--manifest <path>` the visual manifest (`none` — do not check), `--locale ru|en` the language of validation findings. `--dry-run` and `--watch` are mutually exclusive. Blender itself is needed by none of this: the importer's tests run from committed `.gltf`/`.glb` fixtures, and `npm run check` is green without Blender (BLND-7).

`engine/tests/golden/` holds `*.scenario.json` / `*.golden.json` pairs — bitwise baselines of a scenario run. `match-*` pairs are recorded loopback matches (CLI-10): the scenario is written by `integration-ts` (`npm run record`), the golden by the core adapter. `golden.test.ts` compares them exactly; if behavior changed **deliberately and per spec**, regenerate with `npm run golden` from the repository root (re-records matches, then rewrites core baselines) and include the baseline diff in the commit. JSON schemas in `engine/schemas/` are generated from the core — never edit by hand, only via `npm run schemas`.

## Non-negotiable core principles

Violating any of these is a defect, not a trade-off. The same list, worded for spec authoring, is the «Неснимаемые принципы» block of `openspec/config.yaml` — keep the two in step when either changes:

- The only entry into the simulation is `tick(state, inputs) → TickResult`; no I/O or side effects inside a tick — external consumers read `TickResult` afterwards.
- Fixed-point Q16.16 everywhere in the simulation; floats are forbidden in gameplay math.
- Data-driven: systems and gameplay are described in JSON, and the core is a universal evaluator of them.
- ECS mutations go only through the Command Buffer; general-purpose world mutators are deliberately not exported from `src/index.ts` (exporting them would be the side channel TICK-3 forbids). The single exception TICK-3 itself requires: the `worldInit` placement helper (`worldInitSpawn`), published separately from the read-only surface and named for its scope — before the first tick.
- A JSON-defined system and a native TS system are interchangeable behind the single `System` interface.
- Server-authoritative netcode; each client's snapshot is filtered by visibility (FoW is part of the simulation, not the renderer).
- The core has **zero** runtime dependencies — do not add libraries to `engine/core-ts` (ECS libraries and `json-logic-js` were deliberately rejected).
- Mechanism vs policy: the core knows nothing about balance. Any number a game designer might tune lives in JSON systems, not in the core (examples table — `docs/architecture.md` §3).

## Allocation discipline in the core

A working discipline for `engine/core-ts`, not a defect-level rule like the list above:

- The world is mutable by design (TICK-1): `tick()` advances state in place; the past lives as sparse snapshots in `HistoryProvider`, never as per-tick copies.
- The hot path of a tick must not allocate proportionally to entity or system count. Long-lived structures (SoA arrays, dirty Sets, RNG wrappers, the per-tick `SystemContext`) are reused, not recreated each tick.
- `TickResult` is a couple of tiny per-tick objects and a live view over world state — do not pool it; pooling would silently corrupt views observers may hold (OBS-3).
- Deliberate allocation compromises are marked `ponytail` in code comments and get removed when profiling on a real scene shows them, not by taste.

## core-ts layout

`engine/core-ts/src/`, the whole simulation is deterministic:

- `math/` — Q16.16 (`fixed.ts`), vectors, `mathApi` (DI), xorshift128 RNG with named streams.
- `ecs/` — custom SoA storage on TypedArrays (`world.ts`), bit masks, Query API, Command Buffer (`commands.ts`), Event Bus, generational entity IDs. Per-component dirty tracking feeds `TickResult.changes`.
- `dsl/` — the data-driven layer: JsonLogic-compatible expression evaluator (`expr.ts`, custom AST walk), action executor (`actions.ts`), `EvaluatedSystem` (a JSON system in the shared registry), schema generation.
- `systems/` — native TS systems: terrain, physics (broad-phase grid, raycast), visibility/FoW, time/tween/modifiers, arena, input; shared `registry.ts`.
- `sim/` — `tick.ts`, worldInit, serialization (canonical JSON, plain world form), scene config, `HistoryProvider` (snapshot ring buffer), rewind/replay, per-client snapshot filter (`filter.ts`), `contentPackHash`.
- `types.ts` — the contracts the layers meet on: `System`/`SystemContext`, the DI APIs (`MathApi`, `PhysicsApi`, `NavigationApi`, `TerrainApi`), `TickResult`, `InputFrame`.
- `debug.ts` — the diagnostics sink and trace levels (capability `diagnostics`, DIAG-1..7; injected like the other APIs, DI-5). Push during a tick, unlike `TickResult`, which is read after it.
- `bin/sim.mjs` — CLI scenario runner (the basis of golden tests and the future cross-language check against the Rust port).
