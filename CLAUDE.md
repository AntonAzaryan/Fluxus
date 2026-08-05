# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Repository documentation and specs are written in Russian (requirement modality in specs is English: SHALL / MUST NOT). Keep it that way when editing them.

## The repository

`openspec/` is the spec, `engine/` its working implementation (the `*-ts` packages), `content/` the game content the engine runs, `docs/` the non-normative overview. The npm workspace root is the repository root.

Game content lives in `content/` and never inside an engine package (`game-content` CONT-1, enforced by `engine/integration-ts/test/contentBoundary.test.ts`): `content/scenes/`, `content/matches/` are sim documents, `content/visuals/` holds the visual manifest, models and textures, and an asset ID is a path from the tree root (ASSET-2). Engine test fixtures are **not** content and stay put — `engine/tests/golden/` and the scenes built inline in `engine/integration-ts/test/fixtures.ts` (CONT-4): an engine baseline must go red from an engine change, not from a designer retuning a number.

## The spec is the source of truth

`openspec/specs/` (23 capabilities, ~250 requirements) normatively defines what the engine must be. When implementation and spec diverge, the defect is in the implementation (CORE-3). Normative statements live **only** in the specs — do not duplicate them in docs or code.

- Requirements carry historical IDs (`DET-1`, `NET-15`, `FOW-4`…) in `### Requirement:` headers — preserve them; a new requirement takes the next free number of its prefix.
- Changes go through the OpenSpec workflow: `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, etc. (the `openspec-*` skills in `.claude/skills/`). Do not edit specs outside this process.
- The spec covers more than the TS packages — `editor` (Kotlin + Compose, roadmap stage 12) is a capability with no code under `engine/`. Capability ≠ package.
- Spec-writing context and rules — `openspec/config.yaml`.
- Layer overview, roadmap, the mechanism-vs-policy split, open questions — `docs/architecture.md` (alongside `docs/one-pager.md`).
- **Work not yet done is written down, not remembered.** `openspec list` is the live queue of proposed changes; the roadmap table in `docs/architecture.md` says what each stage is for and in what order. A change whose `proposal.md` exists while `specs`/`design`/`tasks` are empty is a deliberate stub — read its `## Notes` and continue with `/opsx:update <name>`.

```sh
openspec list --specs               # list capabilities
openspec spec show netcode          # one spec
openspec validate --specs --strict  # format check
```

## Commands (repository root workspace)

Node >= 22.18. The repository root is the npm workspace; its members are the engine packages (`engine/core-ts`, `engine/net-ts`, `engine/render-ts`, `engine/assets-ts`, `engine/client-ts` — the web client shell (worker hosting + channel, SHELL-1..7), `engine/integration-ts` — the cross-layer integration suite, CLI-9). A single `npm install` from the root installs everything, and the check-everything command before pushing is:

```sh
npm test          # from the root: tests of all packages
npm run typecheck # from the root: tsc --noEmit of all packages
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

`engine/tests/golden/` holds `*.scenario.json` / `*.golden.json` pairs — bitwise baselines of a scenario run. `match-*` pairs are recorded loopback matches (CLI-10): the scenario is written by `integration-ts` (`npm run record`), the golden by the core adapter. `golden.test.ts` compares them exactly; if behavior changed **deliberately and per spec**, regenerate with `npm run golden` from the repository root (re-records matches, then rewrites core baselines) and include the baseline diff in the commit. JSON schemas in `engine/schemas/` are generated from the core — never edit by hand, only via `npm run schemas`.

## Non-negotiable core principles

Violating any of these is a defect, not a trade-off (full list — `openspec/config.yaml`):

- The only entry into the simulation is `tick(state, inputs) → TickResult`; no I/O or side effects inside a tick — external consumers read `TickResult` afterwards.
- Fixed-point Q16.16 everywhere in the simulation; floats are forbidden in gameplay math.
- ECS mutations go only through the Command Buffer; world mutators are deliberately not exported from `src/index.ts` (exporting them would be the side channel TICK-3 forbids).
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
- `bin/sim.mjs` — CLI scenario runner (the basis of golden tests and the future cross-language check against the Rust port).
