# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language policy

- All reasoning, subagent instructions, and inter-agent communication — in English.
- Final responses to the user — in Russian.

### Spec handling

- Specs (`openspec/`) and docs are written in Russian — requirement modality stays English (SHALL / MUST NOT). Keep it that way when editing them; do NOT translate them.
- Reference requirements by ID (e.g. NTR-1, CONT-4, SHELL-3) instead of paraphrasing. When exact wording matters, quote the Russian text verbatim.
- Before implementing, check the relevant capability spec: `openspec spec show <capability>`.
- Navigate specs lazily with `npm run spec-graph -- <cmd>` (`scripts/spec-graph.mjs`): to quote or check a single foreign requirement use `show <ID>` (one section, not the whole spec), find IDs with `find <text>`, expand the task's context via `refs <ID>`, jump from a requirement to the code citing it via `code <ID>` (src/test/generated; a citation means "mentioned", not "implemented"). Before editing a requirement, run `impact <ID>` — it lists what may go stale, including citing code. The capability you are *changing* you still read whole. The tool sees main specs only, not `changes/` deltas; `spec-graph check` lints the reference graph plus dangling IDs in code and is part of the `npm run check` gate.

### Naming

- Names in code are English — identifiers, schemas, field names. The prose inside the code is Russian: comments, the texts of error and validation messages, and test names, so that they read together with the Russian specs they cite. Commit messages follow the repository's own practice: an English conventional-commit prefix (`feat(camera):`, `spec(editor):`, `test:`) with a Russian subject.
- Anglicisms in specs map to their English originals in code (тик → tick, рендер → render); never invent synonyms. Existing names in `engine/` packages are canonical — follow them.

## The repository

`openspec/` is the spec, `engine/` its working implementation (the `*-ts` packages), `editor/` the content editor built on top of them (capability `editor`, roadmap stage 12), `game/` the game applications and the host-side tooling built on the engine (`game/demo-ts` — the demo arena and the demo consumer of capability `client-shell`; `game/server-agent-ts` and `game/server-manager-ts` — the host agent and the manager that drives it, capabilities `server-control` and `server-manager`), `tools/` the Blender level-design pipeline (capability `blender-pipeline`, roadmap stage 35), `desktop/` the Electron desktop container for the editor and the game client (capability `desktop-shell`, roadmap stage 38), `content/` the game content the engine runs, `docs/` the non-normative overview. The npm workspace root is the repository root.

A game app is not engine, and the line matters mechanically: `game/demo-ts` reads `content/` legally — it *is* the game — while an engine package must not (CONT-4). The barrier is the depcruise rule `engine-no-content` (`npm run lint:arch`), and it sees module-graph edges only: a static `import` of `content/**` from `engine/**` is an error, an `fs` read of the same path is invisible to it. So the rule an engine package obeys is stricter than the barrier: the content tree can be absent and it still builds and tests. Where a read of the tree from under `engine/` survives, it is deliberate and explained in place — adding one that is not is a step backwards.

Level design happens in Blender, not in our own editor. `<base>.blend` is paired to a scene by name, Blender's stock glTF exporter writes `<base>.glb` beside it, and the importer `tools/blender-ts` (`@fluxus/blender-ts`, CLI `npm run import`) rewrites **only** the derived spatial layer — `initial` of the scene config (SER-7, SER-8), `decorations` of the paired presentation document (PRES-2), the terrain asset (TERR-3) and the curvature map (ASSET-7) — leaving every other field byte-for-byte (BLND-2). The pipeline is strictly one-directional, deterministic and atomic (BLND-1, BLND-4, BLND-6), and it writes through `editor/core-ts`'s operation layer and canonical save (BLND-5, ED-29, ED-21) — there is no second implementation of validation, serialization or ordering. The Blender add-on lives in `tools/blender-addon/` (Python, outside the npm workspace and outside the `check` gate) and is the main authoring surface, not the law: the guarantee is the import (BLND-8). glTF is the model format of content — the loader is registered in `assets-ts` by ASSET-3 with the canonical representation of ASSET-5, and MDX stays a historical registry format (BLND-11); the models under `content/visuals/` are still MDX until the manual migration lands. Neither the engine nor the client runtime reads `.blend`/`.glb`, and no test needs Blender (BLND-7); the editor keeps preview and data-driven authoring (systems, schemas, prefabs, the manifest), and its level-design direction is frozen.

Game content lives in `content/` and never inside an engine package (`game-content` CONT-1, enforced by `engine/integration-ts/test/contentBoundary.test.ts`): `content/scenes/`, `content/matches/` are sim documents, each scene may have a paired presentation document beside it (`duel.presentation.json` — decorations, capability `presentation-scene` PRES-1), `content/visuals/` holds the visual manifest, models and textures, and an asset ID is a path from the tree root (ASSET-2). Engine test fixtures are **not** content and stay put — `engine/tests/golden/` and the scenes built inline in `engine/integration-ts/test/fixtures.ts` (CONT-4): an engine baseline goes red from an engine change, not from a designer retuning a number.

## The spec is the source of truth

`openspec/specs/` (40 capabilities, 497 requirements) normatively defines what the engine must be. When implementation and spec diverge, the defect is in the implementation (CORE-3). Normative statements live **only** in the specs — do not duplicate them in docs or code.

- Requirements carry historical IDs (`DET-1`, `NET-15`, `FOW-4`…) in `### Requirement:` headers — preserve them; a new requirement takes the next free number of its prefix.
- Changes go through the OpenSpec workflow: `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, etc. (the `openspec-*` skills in `.claude/skills/`). Do not edit specs outside this process.
- Capability ≠ package. `editor` (roadmap stage 12) lives in two packages outside `engine/`, reaches into four more capabilities' specs (`rendering`, `camera`, `serialization`, `assets`) and brought a fifth into being (`presentation-scene` — the paired presentation document its decorations live in); `pathfinding` is no package at all — a seam in `core-ts` plus the search behind it (`src/systems/nav/`, NAV-7..NAV-10). Which requirements of `editor` have code, which are partial and which were out of the pass — `docs/reviews/2026-08-08-editor-coverage.md` (the historical report plus its 2026-08-09 addendum).
- Spec-writing context and rules — `openspec/config.yaml`.
- Layer overview, roadmap, the mechanism-vs-policy split, open questions — `docs/architecture.md` (alongside `docs/one-pager.md`).
- **Work not yet done is written down, not remembered.** `openspec list` is the live queue of proposed changes; the roadmap table in `docs/architecture.md` says what each stage is for and in what order. A change whose `proposal.md` exists while `specs`/`design`/`tasks` are empty is a deliberate stub — read its `## Notes` and continue with `/opsx:update <name>`.

```sh
openspec list --specs               # list capabilities
openspec spec show netcode          # one spec
openspec validate --specs --strict  # format check
```

## Commands (repository root workspace)

Node 22.18+, and the `engines` range of every manifest says it precisely — `>=22.18 <23 || ^24 || >=26`, with `.nvmrc` pinning 22. Odd majors are cut out deliberately: they are development lines, and the toolchain does not support them (dependency-cruiser declares `^22 || ^24 || >=26`), so a plain `>=22.18` would admit a Node the gate cannot run under. The repository root is the npm workspace; its members are the engine packages (`engine/core-ts`, `engine/net-ts`, `engine/render-ts`, `engine/assets-ts`, `engine/client-ts` — the web client shell (worker hosting + channel, SHELL-1..9), `engine/hud-ts` — the HUD widgets (capability `match-hud`), `engine/bot-ts` — the bot player (capability `bot-player`), `engine/integration-ts` — the cross-layer integration suite, CLI-9) plus the two editor packages (`editor/core-ts` — the headless authoring layer, `editor/ui-ts` — its DOM interface and web app), the demo game app (`game/demo-ts` — the arena built on the client shell; its web app lives under `app/`, the demo-arena stand under `bin/` (`demo-serve.mjs` — the dedicated server with the bot slot-filler and auto-restart, `npm run demo:serve`; the dev server starts one alongside the page by itself, `app/demoStand.ts`, so two-human play needs no second command — `npm run demo:lan` prints the link for the other player), and both it and the tests read `content/` legally), the host agent and its manager (`game/server-agent-ts` — the headless supervisor of match-server processes plus the control protocol and the client hand-out, capability `server-control`; `game/server-manager-ts` — the operator's web app over that protocol, capability `server-manager`), the Blender importer (`tools/blender-ts` — glTF parsing, spatial-layer generation and the `import` CLI; the `tools/blender-addon/` add-on is Python and is **not** a workspace member) and the desktop container (`desktop/shell-ts` — the Electron shell hosting the editor and the game client, capability `desktop-shell` DSK-1..8; Electron itself stays outside the `check` gate). A single `npm install` from the root installs everything, and the check-everything gate before pushing is `npm run check` — it is `lint:all && spec-graph check && test`, where `lint:all` is `typecheck && lint && lint:dead && lint:dup && lint:arch` (eslint, knip, jscpd and dependency-cruiser — the last one carries the `engine-no-content` barrier). The chain is unchanged by scheduling: `typecheck` is one `tsc --noEmit` per package run in parallel by core count (`scripts/typecheck.mjs`) and `test` is a single vitest pool over the workspace projects (`vitest.gate.config.ts` + `vitest.projects.ts`, names deliberately non-canonical so a per-package `npm test -w <pkg>` is not hijacked) — same checks, same verdict, fewer process starts. Parallelism is licensed by the gate's own invariant (CLI-13): no stage writes what another reads, so order and concurrency cannot change the verdict, and regenerating baselines and schemas stays an explicit command (CLI-5). There are no CI runners; the gate is client-side — `scripts/git-hooks/pre-push` (wired via `core.hooksPath` by the session-start hook; `git config core.hooksPath scripts/git-hooks` locally) rejects a push of `main` while `npm run check` is red. Feature branches are not gated: there, running only a subset is how a lint, architecture or spec-graph failure reaches the remote:

```sh
npm run check     # from the root: lint:all + spec-graph check + test — run this before pushing
npm test          # from the root: tests of all packages, one vitest pool over the workspace projects
npm run typecheck # from the root: tsc --noEmit of every package, in parallel by core count
npm run lint      # from the root: eslint . --max-warnings 0
npm run lint:all  # from the root: typecheck + eslint + knip + jscpd + depcruise
npm run check:impact  # selective gate run over the packages the working diff can affect;
                      # `-- --dry-run --explain` prints the plan and the rule behind every pick.
                      # NOT the gate of `main` — a green selection never replaces `npm run check`
npm run check:timings # the full gate stage by stage with seconds — cost as a number, not a feeling
npm run golden:cost # regenerate cost and memory baselines (*.cost.json, *.footprint.json) — an explicit acceptance
npm run bench:demo  # manual browser bench of the demo arena vs a device profile — diagnostic, not a gate
npm run bots:sync   # sync bot-profile ability entries from the scene + its <base>.bots.json annotations (BOT-13);
                    # verification itself is a demo test inside npm run check — the CLI is the designer's pen, not the gate
```

The inner loop has a selective run (CLI-14): `npm run check:impact` (`scripts/impact.mjs`) takes the diff from the merge-base with `main` plus the working tree, maps every changed path to a package, closes over declared `@fluxus/*` dependencies **and** the declared test edges of the map (who reads a foreign tree past the manifest), and runs type-check, lint and tests for that selection only; knip, jscpd, dependency-cruiser and `spec-graph check` always run whole, and the integration suite (CLI-9) joins any non-empty code selection. The map — wide gates, test edges, path rules — is data inside that script, like the guard lists of CLI-8: editing it lands in the review diff, an unknown path falls back to the full gate, and a test reading a foreign tree past the map reddens `engine/integration-ts/test/impactMap.test.ts` in the ordinary test run. **The selection is not the gate of `main`**: `pre-push` runs the full `npm run check` there, and a hole in the map costs an extra full run, never a missed regression.

`npm run coverage` (root, `vitest.coverage.config.ts`) is a diagnostic, not a gate: no thresholds, and the percentage is not a goal. Read it as the list of what no test executes — a DSL operator exposed to content but never evaluated, a transport branch no match reaches. Run it package-by-package and it lies: `integration-ts` exercises core/net/render, so only the aggregate run counts. The aggregate covers everything the gate holds with tests — the engine packages, `editor/*`, `tools/blender-ts` and the demo app (measured at `app/`, it has no `src/`); outside it is `desktop/shell-ts` alone, because the Electron container stays outside the gate (DSK-6).

Per-package commands run from the package directory (or via `npm run <script> -w @fluxus/<name>` from the root). From `engine/core-ts/`:

```sh
npx vitest run test/physics.test.ts      # one file
npx vitest run -t "test name"            # one test by name
npm run sim -- <scenario.json>           # CLI scenario run (bin/sim.mjs)
npm run golden                           # regenerate golden baselines (UPDATE_GOLDEN=1)
npm run schemas                          # regenerate engine/schemas/*.json (UPDATE_SCHEMAS=1)
```

The demo game runs from the root as `npm run demo` (= `npm run dev -w @fluxus/demo`; Vite serves `content/` as the content tree, `game/demo-ts/app/vite.config.ts`). The editor's web app runs from the root as `npm run dev -w @fluxus/editor-ui` (Vite; `app/vite.config.ts` serves `content/` as the content tree and adds the tree-listing endpoint the web environment host needs — a `vite build` has neither listing nor write, and says so, ED-12).

The Blender import runs from the root (`tools/blender-ts/bin/import.mjs`):

```sh
npm run import -- <path to .glb|.gltf>              # import the spatial layer of the paired scene
npm run import -- <src.glb> --dry-run               # same checks and same target layer, no write; result as JSON on stdout
npm run import -- <src.glb> --watch                 # re-import on every save of the source (hot-reload, BLND-12)
```

`--root <dir>` overrides the content tree root (default — `content/` beside the working directory), `--manifest <path>` the visual manifest (`none` — do not check), `--locale ru|en` the language of validation findings. `--dry-run` and `--watch` are mutually exclusive. Blender itself is needed by none of this: the importer's tests run from committed `.gltf`/`.glb` fixtures, and `npm run check` is green without Blender (BLND-7).

`engine/tests/golden/` holds `*.scenario.json` / `*.golden.json` pairs — bitwise baselines of a scenario run. `match-*` pairs are recorded loopback matches (CLI-10): the scenario is written by `integration-ts` (`npm run record`), the golden by the core adapter. `golden.test.ts` compares them exactly; if behavior changed **deliberately and per spec**, regenerate with `npm run golden` from the repository root (re-records matches, then rewrites core baselines) and include the baseline diff in the commit. JSON schemas in `engine/schemas/` are generated from the core — never edit by hand, only via `npm run schemas`.

`*.cost.json` beside them are the **cost baselines** (capability `performance-budget`, PERF-3/PERF-4): deterministic work counters — tick work from the core's `TICK_COST` diagnostics records, whose summary keeps one counter per core platform whose per-tick work grows with content (commands and DSL expressions, physics broad-phase and rays, path nodes, NPC neighbours, ability targeting candidates, projectile steps and buff instances, visibility pairs, tween steps, bus events — one counter shared by two platforms is forbidden, PERF-3), `extract`/`syncTick`/`frame` counters of the render's cost sink — summed over the same recorded matches, sectioned per quality preset (`performance`/`ultra`, with `tick` and `extract` once each — neither the sim nor the copy of the world into the flat form depends on the preset, QUAL-2). The `extract` stage is the worker half of the tick stream (PERF-2): the extractor's own work plus the volume it *offers* the channel (`extractChannelValues`). The channel's own work — pool buffer regrowth, the message envelope, the append-only kind-table tail, the conflation ratio — stays unmeasured on purpose: the sender conflates (entity state is serialized from the last `extract` when the main thread returns a buffer), so real traffic depends on main-thread timing and cannot be a reproducible PERF-3 baseline. `scaling.cost.json` holds the render axes at two sizes each, and `npc-stress.cost.json` / `nav-path.cost.json` / `ability-stress.cost.json` do the same for the three simulation-side axes (agents of the NPC behaviour platform, agents asking for paths, agents casting abilities — the last one a synthetic load built in `benchLoad.ts`, since the scene is a function of the axis size) — the L/S ratio is what makes super-linear growth visible (PERF-6). They are part of the `npm run check` gate and machine-independent; a red diff is a real cost change, never noise. Regenerate **only** via `npm run golden:cost` from the root (deliberately not part of `npm run golden` — accepting a cost increase is its own decision) and include the diff in the commit. Wall-time numbers printed as `[bench] …` by `bench.test.ts` files are sentinels: they assert only order-of-magnitude degradation and must never gate harder (PERF-5). `npm run bench:demo` is the manual browser bench of the demo arena (PERF-7, diagnostic, not a gate): real Chromium over CDP, p50/p99 frame/stage timings against a reference device profile from `game/demo-ts/bench/profiles/` (data, tunable without code); in `--drive` mode it also prints, at the window boundaries and outside the measured window, the page heap after a forced GC (CDP `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`) and the renderer's live geometries and textures (`render.memory`) — diagnostics, never the verdict.

`*.footprint.json` beside them are the **memory baselines** (PERF-8): the same loads and the same axes as the cost ones, but the arithmetic is a **peak**, not a sum — memory is state, not work. A document holds the peaks of the core's `TICK_FOOTPRINT` records (world capacity in bytes of typed arrays, live entities and free slots, tag entries, per-tick peaks of the command buffer and the event log, path-search heap capacity), the history section (`snapshots × worldBytes` — the bytes of the full copies of SNAP-4) and, per quality preset, the live GPU resources by owner and kind plus the sizes of delivery state and REND-31 caches. Bytes of the runtime heap are **not** in them and must not be (PERF-8): they move with the runtime version at unchanged code. They regenerate by the same `npm run golden:cost` — accepting a memory increase is the same one gesture as accepting a cost one. Two invariants stand beside the baselines and need none (PERF-9): after the presentation tract is torn down every subsystem's live resource count is zero, and a load with constant turnover leaves the quantities unmoved between two points of the run (`integration-ts/test/steadyState.test.ts`, `render-ts/test/lifetime.test.ts`); the completeness of the resource accounting is guarded by a source scan — a `new THREE.<resource>(…)` outside `own(…)` is a red line with file and line (`render-ts/test/guard.test.ts`, by CLI-8). Real process memory is watched by two sentinels of the `[bench]` kind (never a baseline): PERF-10 measures the heap **after** a forced GC — growth between steady-state points, never the level — and PERF-11 the garbage **between** collections (minor GCs per thousand ticks and the bytes of a window with no collection at all); both live in `integration-ts/test/memory.test.ts` (the PERF-10 delivery-turnover sentinel also in `client-ts/test/bench.test.ts`) over the shared helper `engine/tests/bench/memory.ts`, print on every run and assert only an order of magnitude.

Debugging a fight starts by reading a file, not by asking questions (capabilities `diagnostics` DIAG-8..10, `cli-testing` CLI-11..12). Two commands, run from the root:

```sh
npm run demo:debug                                  # a whole match, no human: bots take the slots, it ends by itself,
                                                    # artifacts land in runs/latest/ (trace.jsonl, match.scenario.json,
                                                    # journal.jsonl, run.json). --max-ticks, --out-dir, --port override it.
                                                    # It samples its own process memory on a cadence in TICKS
                                                    # (--memory-every, default tickRate × 10) and prints the first
                                                    # and last sample plus the slope per 1000 ticks into its own
                                                    # report; --memory-out <path> writes the series as a separate
                                                    # JSONL file. The values are environment data: no comparable
                                                    # artifact carries them, and run.json is unchanged (CLI-11)
npm run sim -- <scenario.json> --trace=full --trace-out=trace.jsonl   # the same trace off a scenario run
npm run sim -- runs/latest/match.scenario.json \
  --trace=full --trace-select=event                                  # re-shoot a selected match trace from its recording
npm run journal -- runs/latest/trace.jsonl \
  --dict=game/demo-ts/app/journal/duel.dictionary.json               # trace → battle journal (jsonl; --format=text for columns)
```

Every flag of these commands takes both forms — `--trace=full` and `--trace full` — and the same `--trace-select` vocabulary (record kinds and codes) is parsed by one function for the scenario CLI and the match launchers alike (CLI-11).

The trace is a JSONL stream of core diagnostics records plus host lines marking the branch of history (`{"mark":"live"|"replayBegin"|"replayEnd","epoch":…,"tick":…}`); drop the marks and you get exactly the trace a replay of the recording produces — that pairing is a test (DIAG-9). Hence the rule the debug run obeys: the recording (`match.scenario.json`) always lies next to the trace, because bots and humans generate the input, not a seed, and a trace with nothing to re-shoot it with is a dead end. A rewound match has no flat recording at all (NTR-16) — the run says so instead of writing a truncated one. A full-level trace is large enough that combat is measured in tens of MiB per minute, and `--trace-select` is how you make it readable: it is a sink-side predicate, never a fourth trace level (DIAG-9), and it never drops broken-invariant records (FP-4). The journal's `event type → semantics` dictionary is **game data** (`game/demo-ts/app/journal/`), not tool constants: a new effect is a line in that document, and an unknown type reaches the journal with unknown semantics and is named in the run report rather than vanishing. Traces and journals never enter golden baselines (CLI-7, CLI-12).

Render quality presets (capability `render-quality`): subsystems declare cost knobs at registration (`QualityController` in `engine/render-ts`), preset documents are game policy in `game/demo-ts/app/presets/{performance,balanced,ultra}.json` — the demo defaults to `balanced` (persisted in localStorage), the editor viewport hardwires ultra inline. Ceiling-semantics knobs (e.g. `fog.maskResolution`) clamp the scene-authored value via `min(scene, ceiling)` and never mutate the scene document (FOW-10); presets must not change the simulation or player-visible information (QUAL-2). A new render feature whose per-frame cost grows with content must declare a knob or explicitly declare constant cost (QUAL-3).

## Non-negotiable core principles

Violating any of these is a defect, not a trade-off. The same list, worded for spec authoring, is the «Неснимаемые принципы» block of `openspec/config.yaml` — keep the two in step when either changes:

- The only entry into the simulation is `tick(state, inputs) → TickResult`; no I/O or side effects inside a tick — external consumers read `TickResult` afterwards.
- Fixed-point Q16.16 everywhere in the simulation; floats are forbidden in gameplay math.
- Data-driven: systems and gameplay are described in JSON, and the core is a universal evaluator of them.
- ECS mutations go only through the Command Buffer; general-purpose world mutators are deliberately not exported from `src/index.ts` (exporting them would be the side channel TICK-3 forbids). TICK-3 itself carves out exactly four exceptions, and gameplay code may use none of them. Three are the core's own lifecycle operations, closed to the outer layer too: `worldInit` placement, rewind state restore and the exempt-field rewrite. The fourth belongs to the outer layer and to exactly one mode — the network shell applying an authoritative snapshot to a world that never ticks at all (`client-shell` SHELL-8); the world of a *running* simulation stays closed. Two of them are *exported*: the `worldInit` placement helper (`worldInitSpawn`), named for its scope and usable only before the first tick, and snapshot application (`restoreSnapshot`), whose unit of work is the whole state rather than a field, an entity or a component set.
- A JSON-defined system and a native TS system are interchangeable behind the single `System` interface: rewriting one into code for speed changes nothing around it.
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
- `systems/` — native TS systems: terrain, physics (broad-phase grid, raycast, column model), visibility/FoW, time/tween/modifiers, arena, input, locomotion; plus three subtrees — `abilities/` (the ability and buff platform: definitions, cast phases, targeting, projectiles, cooldowns, interrupts), `npc/` (the NPC behaviour platform: director, behaviour, threat, movement) and `nav/` (path search behind the Navigation API: bake, A*, smoothing). Shared `registry.ts`.
- `sim/` — `tick.ts`, worldInit, serialization (canonical JSON, plain world form), scene config, `HistoryProvider` (snapshot ring buffer), rewind/replay, per-client snapshot filter (`filter.ts`), `contentPackHash`.
- `types.ts` — the contracts the layers meet on: `System`/`SystemContext`, the DI APIs (`MathApi`, `PhysicsApi`, `NavigationApi`, `TerrainApi`), `TickResult`, `InputFrame`.
- `debug.ts` — the diagnostics sink and trace levels (capability `diagnostics`, DIAG-1..7; injected like the other APIs, DI-5). Push during a tick, unlike `TickResult`, which is read after it.
- `sim/journal.ts` — the battle journal (DIAG-10): a pure projection of a saved trace file into facts, with the `event type → semantics` mapping arriving as a document. Deliberately **not** exported from `src/index.ts` (CLI-8) — `bin/journal.mjs` imports it directly, the way `bin/sim.mjs` imports `sim/scenario.ts`.
- `bin/sim.mjs` — CLI scenario runner (the basis of golden tests and the future cross-language check against the Rust port); `bin/journal.mjs` — the journal CLI (CLI-12); `bin/tsHook.mjs` — the resolve hook both of them register.
