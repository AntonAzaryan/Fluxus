# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Repository documentation and specs are written in Russian (requirement modality in specs is English: SHALL / MUST NOT). Keep it that way when editing them.

## Two parts of the repository

- `engine/` — **current**: the OpenSpec specification of the engine + the working core implementation `core-ts/`.
- `draft/` — historical sandbox (its own npm workspace, mapped in `draft/AGENTS.md`). **Not a source of truth**; touch only if the task is explicitly about it.

## The spec is the source of truth

`engine/openspec/specs/` (17 capabilities, ~199 requirements) normatively defines what the engine must be. When implementation and spec diverge, the defect is in the implementation (CORE-3). Normative statements live **only** in the specs — do not duplicate them in docs or code.

- Requirements carry historical IDs (`DET-1`, `NET-15`, `FOW-4`…) in `### Requirement:` headers — preserve them; a new requirement takes the next free number of its prefix.
- Changes go through the OpenSpec workflow: `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, etc. (the `openspec-*` skills in `engine/.claude/skills/`). Do not edit specs outside this process.
- Spec-writing context and rules — `engine/openspec/config.yaml`.
- Layer overview, roadmap, the mechanism-vs-policy split, open questions — `engine/docs/architecture.md`.

```sh
cd engine
openspec list --specs               # list capabilities
openspec spec show netcode          # one spec
openspec validate --specs --strict  # format check
```

## Commands (engine/core-ts)

Node >= 22.18. All commands from `engine/core-ts/`:

```sh
npm test                                 # vitest, all tests
npx vitest run test/physics.test.ts      # one file
npx vitest run -t "test name"            # one test by name
npm run typecheck                        # tsc --noEmit
npm run sim -- <scenario.json>           # CLI scenario run (bin/sim.mjs)
npm run golden                           # regenerate golden baselines (UPDATE_GOLDEN=1)
npm run schemas                          # regenerate engine/schemas/*.json (UPDATE_SCHEMAS=1)
```

`engine/tests/golden/` holds `*.scenario.json` / `*.golden.json` pairs — bitwise baselines of a scenario run. `golden.test.ts` compares them exactly; if behavior changed **deliberately and per spec**, regenerate with `npm run golden` and include the baseline diff in the commit. JSON schemas in `engine/schemas/` are generated from the core — never edit by hand, only via `npm run schemas`.

For `draft/`: `cd draft && npm test` (core tests), `npm run dev:render` (Three.js prototype).

## Non-negotiable core principles

Violating any of these is a defect, not a trade-off (full list — `engine/openspec/config.yaml`):

- The only entry into the simulation is `tick(state, inputs) → TickResult`; no I/O or side effects inside a tick — external consumers read `TickResult` afterwards.
- Fixed-point Q16.16 everywhere in the simulation; floats are forbidden in gameplay math.
- ECS mutations go only through the Command Buffer; world mutators are deliberately not exported from `src/index.ts` (exporting them would be the side channel TICK-3 forbids).
- A JSON-defined system and a native TS system are interchangeable behind the single `System` interface.
- Server-authoritative netcode; each client's snapshot is filtered by visibility (FoW is part of the simulation, not the renderer).
- The core has **zero** runtime dependencies — do not add libraries to `engine/core-ts` (ECS libraries and `json-logic-js` were deliberately rejected).
- Mechanism vs policy: the core knows nothing about balance. Any number a game designer might tune lives in JSON systems, not in the core (examples table — `engine/docs/architecture.md` §3).

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
