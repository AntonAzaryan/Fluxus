# Blender as a Level Editor for Fluxus: A Practical Implementation Guide

> Импорт исследования (2026-08-09). Источник — PDF «Blender as a Level Editor for Fluxus: Practical glTF Pipeline Implementation Guide», текст перенесён без правок и переводу не подлежит: это внешний исходный материал, а не документ репозитория. Ненормативно: нормой является capability `blender-pipeline` (change `blender-level-design-integration`); при расхождении прав спек. Отчёт — обоснование выбора маршрута «Blender → glTF → импортёр» (Route B).

## TL;DR

Adopt the glTF-extras route, not a direct JSON bpy addon: author arenas in Blender, export `.glb` with "Custom Properties" enabled, and write a Node/TypeScript importer that converts glTF extras → userData into your JSON sim-document format. This reuses three.js's GLTFLoader (which already maps extras to `Object3D.userData`), avoids maintaining a brittle Python serializer against Blender version churn, and gives you a validated intermediate you can round-trip. Keep the pipeline strictly one-way (Blender→engine).

This is a proven pattern: Bevy (Blenvy / `bevy_gltf_blueprints`), Godot (`@tool` + import hints), Castle Game Engine, and indie devs (Lucas Pope on Maya for Obra Dinn; Sony Santa Monica on Maya for God of War) all use a DCC-as-level-editor pipeline. The universal advice: fix coordinate/unit conventions on day one, use collections as scene organization, Empties as markers, and custom properties for gameplay metadata.

v1 effort with heavy LLM assistance is small: a functional glTF→sim-document importer + a minimal Blender "add game object" panel + save-time auto-export + a file-watcher hot-reload into your existing Vite/WebSocket dev client is roughly 2–4 focused days of AI-accelerated work, because each piece is a well-trodden path with abundant reference code.

## Key Findings

### 1. What Blender gives you as a level editor

- **World-class object placement**: snapping (grid/vertex/edge/face), precise numeric transform entry, arrays, mirroring, and non-destructive layout tools far exceed anything you'd build in-house in a reasonable timeframe. As Taha, author of the "How I wrote the fastest Blender exporter and so could you!" devlog, puts it: "The quality of your level editor directly determines the quality of your game. The better your development tools are and the faster your iteration cycles are, the higher the quality of your game… A tool like Blender can be repurposed to create great levels and it will give a huge head start."
- **Collections = scene hierarchy/organization**: nest collections ("Arena_01/Props", "Spawns", "Colliders") and use them as semantic groups in export.
- **Empties = spawn points/triggers/markers**: per the Blender 5.2 LTS Manual, "The 'empty' is a single coordinate point with no additional geometry. Because an empty has no volume and surface, it cannot be rendered. Still it can be used as a handle for many purposes." It carries a transform (position + orientation + size) and custom properties but exports as a zero-cost node. `empty_display_type` (`PLAIN_AXES`, `CUBE`, `SPHERE`, `CONE`, etc.) lets you visually distinguish marker kinds in the viewport.
- **Custom properties (ID properties) = gameplay metadata**: arbitrary key/values on any object (entity type, prefab reference, collision flags, team, etc.). Blender's glTF exporter writes these to the `extras` field when "Custom Properties" is enabled.
- **Asset Browser + linked libraries = a "prefab" workflow**: mark collections as assets, drag them in as collection instances (an Empty referencing the collection). Library overrides let you tweak per-instance. This is the closest Blender-native equivalent to prefabs.
- **Camera/lighting preview**: you can preview a 2.5D camera framing directly, though final look must be validated in-engine.

Limitations (all confirmed by practitioners):

- **No live game preview**: "the Blender editor preview doesn't show your scene with the final lighting through your engine's rendering pipeline" (Substack) — mitigated by hot-reload.
- **No gameplay-specific volumes natively**: trigger/collision volumes must be represented by convention (tagged primitives or named meshes); Blender has no first-class "trigger volume" concept.
- **Iteration friction without automation**: manual export/import is the pain point every devlog cites; auto-export + hot-reload is what makes it viable.

### 2. Export pipeline: the two routes compared

**Route A — custom bpy JSON exporter** (writes your sim-document directly). Feasible and not hard with LLM help. Key APIs (verified against the Blender Python API): iterate `bpy.data.objects` or a collection; read transforms from `obj.matrix_world`; read custom props via the dict-like `obj.items()` / `obj.keys()` / `obj["k"]`; detect kind via `obj.type` (`'MESH'`, `'EMPTY'`, `'CAMERA'`, `'LIGHT'`) and `obj.empty_display_type`; read `obj.users_collection` and `obj.parent`. One-click export via a `bpy.types.Operator` + File > Export menu entry using `ExportHelper`. Headless/CI export via `blender file.blend --background --python export.py`.

- Pros: output is exactly your format, no second conversion step, full control over what's emitted.
- Cons: you own coordinate conversion, quaternion component-order handling, and property coercion yourself; the addon must be maintained against Blender API churn (Blender internals "change a lot in version updates" per the exporter devlog); you don't get mesh geometry export "for free" (you'd re-implement or still emit glTF for meshes anyway).

**Route B — glTF/GLB export + Node/TypeScript importer (RECOMMENDED).** Use Blender's built-in glTF 2.0 exporter with Include ▸ Custom Properties checked; per the Blender manual these "are stored in the extras field on the corresponding object in the glTF file." On the engine side, three.js GLTFLoader already assigns `nodeDef.extras` to `Object3D.userData`, so your importer walks the loaded scene graph (or parses the `.gltf` JSON directly in Node) and maps userData → sim-document entities.

- Pros: the exporter is maintained by Blender/Khronos (no version-churn burden on you); coordinate conversion (Z-up→Y-up) is handled by the exporter's "+Y Up" option; mesh geometry, materials, instancing all come along; fits your three.js stack natively; you can validate `.glb` with standard tooling (`gltf-transform inspect`).
- Cons: custom-property typing is loose (glTF `extras` is `any`; three.js has documented edge cases discussed below); you need a conversion step glTF→sim-document rather than emitting sim-documents directly; you must decide whether meshes live in the level `.glb` or are referenced by asset-ID.

**Route C — existing tools worth studying** (not necessarily reusing wholesale):

- **Blenvy / bevy_gltf_blueprints** (kaosat-dev): the most mature "Blender as editor" reference. Defines components as custom properties, uses collections as blueprints/prefabs, and — per its README — provides "an automatic export of your level/world from Blender to gltf whenever you save your Blend file… change detection, so that only the levels & blueprints you have changed get exported when you save your blend file." Crucially, its Blender UI "is automatically generated based on a registry schema file, an export of all your registered Bevy components's information, generated by the registry export part of the Blenvy crate" — directly analogous to your auto-generated JSON schemas.
- **ROOTEngine-BlenderPlugin**: minimal panel adding a "GameObject type" dropdown per object, then exports glb with custom properties (github) — a good minimal-scope template.
- **Godot's `@tool` + import-hint workflow** (rileyb3d devlog: "Everything in my Godot scene comes from Blender!") and Godot's suffix conventions. Per the b3dhub "Blender to Godot" docs: "A mesh node with the -navmesh suffix will be converted to a navigation mesh. The original Mesh object will be removed at import-time… If a mesh is imported with the -occ suffix an Occluder3D node will be created… A mesh node with the -rigid suffix will be imported as a RigidBody3D." A battle-tested naming-convention scheme.
- **Needle Engine**: production glTF-from-Blender pipeline with hot reload ("changes are detected and only that scene re-exports automatically").
- **Castle Game Engine**: documents Blender→glTF as its recommended path and reads Blender custom properties.

### 3. Real-world case studies & conventions

- Lucas Pope (Return of the Obra Dinn) and Sony Santa Monica (God of War) use Maya as their level editor with export to custom formats — cited as precedent by the Blender-exporter devlog author.
- Tiny Glade ships on a custom renderer + Bevy ECS; the community even built a Blender addon to import its scene JSON.
- Godot indie devs (rileyb3d, lukasaurus "Building the City"): build the whole level in Blender, use collections to group areas, model collision meshes alongside visuals, and use naming suffixes so the engine knows what's what. Reported pain: modular-kit assembly "looked modular"; repeated export/re-import "just got old" (itch) — automate it.
- Conventions that recur: (a) collections as semantic groups; (b) naming prefixes/suffixes for special objects; (c) custom-property schemas for typed metadata; (d) apply transforms before export to avoid pivot/scale surprises. On collision hulls, per StraySpark's "Blender Collision Meshes for Game Engines": "Unreal recognizes collision by FBX prefix: UCX_ (convex hull), UBX_ (box), USP_ (sphere), UCP_ (capsule). The collider must be named UCX_<MeshName>_## so the importer binds it to the matching render mesh."
- Pain points reported: coordinate systems (Z-up vs Y-up), units/scale (off-by-100 scale is a classic FBX/glTF gotcha), pivot points, non-applied transforms causing spawn offsets, "export drift", and versioning `.blend` files in git.
- Git/`.blend` versioning: `.blend` are binary — track with git-LFS (`*.blend filter=lfs diff=lfs merge=lfs -text`), and, because binaries can't merge, use LFS file locking or a solo-friendly "one editor at a time" discipline. Common team practice: keep source `.blend` in a separate repo/LFS and commit only the exported artifacts (`.glb`/JSON) alongside code. For a solo dev this is simpler: LFS for `.blend`, plain git for the generated JSON/glb.

### 4. Gameplay-metadata patterns

- Prefer custom properties over naming conventions for anything typed/structured (entity type, prefab id, numeric params), because they survive as glTF `extras` and are self-describing. Use naming conventions only for a few coarse, visible categories (e.g. an object-name prefix that the importer keys on) and collections for grouping.
- Collision volumes: represent as simple primitive meshes (box/sphere/capsule/convex) tagged via a custom property (`collider: "box"`) or a name suffix; export the primitive's transform + type rather than the tri-mesh where possible. Unreal's `UCX_` and Godot's `-col` / `-colonly` are the reference conventions; note KatsBits' caveat that there's "no succinct uniform way" across engines, so you define your own.
- Trigger volumes: same as colliders but with a `trigger: <id>` property; export as an oriented box with a size.
- Spawn points / nav hints: Empties with `empty_display_type` chosen per kind + a custom property (`spawn_team`, `nav_hint`).
- Ergonomic authoring UI: build a `bpy.types.Panel` in the N-sidebar backed by a `PropertyGroup` (registered via `PointerProperty` on `bpy.types.Object`) plus `Operator`s ("Add Spawn Point", "Tag as Collider"). This is exactly what the Blenvy and ROOTEngine plugins do — a dropdown of object types + one-click buttons beats hand-editing raw custom properties. Blenvy goes further and auto-generates the panel from the engine's exported component registry (a JSON schema) — which maps perfectly onto your existing auto-generated JSON schemas.

### 5. Iteration loop / hot reload

Auto-export on save: register a `bpy.app.handlers.save_post` handler (with the `@persistent` decorator) that runs your glTF/JSON export whenever the `.blend` is saved. Append in `register()`, remove in `unregister()`, guard against double-registration. The canonical shape (from the official Blender API docs, `load_post` example, identical mechanism for `save_post`):

```python
import bpy
from bpy.app.handlers import persistent


@persistent
def export_on_save(filepath):
    run_my_gltf_export()


def register():
    if export_on_save not in bpy.app.handlers.save_post:
        bpy.app.handlers.save_post.append(export_on_save)


def unregister():
    if export_on_save in bpy.app.handlers.save_post:
        bpy.app.handlers.save_post.remove(export_on_save)
```

- File watcher → live reload: watch the exported `.glb`/JSON directory; on change, push a reload message over your existing WebSocket infra (or Vite's own HMR websocket) to the running client, which disposes the current arena and re-loads it. This reuses the exact mechanism Vite uses (a ws message with a `full-reload`/custom type). Needle and Blenvy both implement this "save in Blender → see it instantly in-engine" loop, which the devlogs agree is what "effectively eliminates" Blender's no-live-preview drawback.
- One-way vs two-way: Recommend strictly one-way (Blender→engine). Two-way sync (engine edits written back to `.blend`) is a large maintenance/complexity burden with real merge-hazard, and none of the referenced indie pipelines bother with it — they keep Blender as the single source of truth and hand-edit only the non-spatial JSON.

### 6. Concrete recommendation for Fluxus

Author in Blender: arena geometry, static prop placement (via collection-instance "prefabs"), spawn points/triggers/markers (Empties), collision/trigger volumes (tagged primitives), camera framing reference, and per-object gameplay metadata (custom properties).

Keep in hand-edited JSON: match rules, wave/spawn logic, tuning tables, anything non-spatial — your sim-documents remain the authority for gameplay systems; Blender only owns the spatial/scene layer.

Pick: **Route B (glTF-extras) with a thin TypeScript importer**. Justification: it rides three.js's native GLTFLoader → userData mapping, offloads coordinate conversion and mesh export to Blender's maintained exporter, and slots into your Vite/TS build as a `content/scenes/*.glb` → sim-document JSON transform validated against your existing generated schemas.

Coordinate/units conventions to fix on day one:

- Up-axis: enable "+Y Up" in the glTF exporter (Blender authors in Z-up; glTF/three.js are Y-up; the conversion is a −90° rotation about X). Decide and never change it.
- Units/scale: 1 Blender unit = 1 engine unit (meter); apply scale (Ctrl+A) before export so no object carries non-unit scale.
- Apply transforms: rotations/scales applied; pivots at intended origins to avoid spawn offsets.
- Quaternion order: Blender `mathutils.Quaternion` is `(w,x,y,z)`; three.js/glTF is `(x,y,z,w)` — handle in the importer if reading raw.
- Naming/collection schema: agree prefixes (e.g. `spawn_`, `trig_`, `col_`) and collection names up front.

Minimal Blender addon feature list (v1):

1. A PropertyGroup on Object with the core fields (entity_type enum, prefab_id, collider_type, flags) + an N-panel to edit them ergonomically.
2. Operators: "Add Spawn Point", "Add Trigger Volume", "Tag as Collider" (create the right Empty/primitive with properties pre-filled).
3. `save_post` auto-export to `.glb` with Custom Properties + "+Y Up" enabled.
4. (Optional) generate the enum lists from your engine's exported JSON schema so Blender and engine stay in sync — mirrors the Blenvy registry-export pattern.

Engine-side (TypeScript) v1:

1. Importer: load `.glb`, walk scene, map userData → sim-document entities, resolve asset-IDs against your content-tree registry, validate against generated schema, write `content/scenes/<arena>.json` (or load directly).
2. Watcher + WebSocket reload hook into the running client.

Effort estimate (AI-accelerated, solo): the glTF→sim-document importer is roughly a day; the minimal Blender panel + operators + `save_post` export another day; the watcher/hot-reload wiring a half-day given you already have Vite + WebSocket infrastructure. Call it ~2–4 focused days for a working v1, with polish (asset-browser prefab conventions, collider primitives, schema-driven enums) as fast follow.

## Details

**glTF extras ↔ three.js userData.** three.js GLTFLoader sets `node.userData = nodeDef.extras`, and per the official three.js GLTFLoader docs, "Metadata from unknown extensions is preserved as '.userData.gltfExtensions' on Object3D, Scene, and Material instances, or attached to the response 'gltf' object" (e.g. `mesh.userData.gltfExtensions.EXT_foo`). Mozilla Hubs uses exactly this to serialize entity-component data into glTF nodes and rehydrate components on load — the canonical proof that glTF `extras` is a valid game-scene serialization channel. Known edge cases to handle in your importer, per three.js GitHub issue #29768: "GLTFLoader assigns a primitive's .extras/userData to a BufferGeometry. If the geometry is cached, a primitive may get geometry with the wrong .extras/userData… if a glTF mesh has only one primitive, then GLTFLoader will collapse the primitive and the mesh into one THREE.Mesh object, and the mesh name appears nowhere in the resulting scene." Practical mitigation: put gameplay metadata on the node/object (empties, parent objects), not on single-primitive meshes, and/or parse the `.gltf` JSON directly in Node where node-level extras are unambiguous.

**Custom-property access (verified APIs).** Iterate `obj.items()`; skip internal keys `_RNA_UI`, `cycles`, and anything starting with `_`. Values come back typed: scalars as `int`/`float`/`str`, arrays as `IDPropertyArray` (coerce with `.to_list()`), groups as `IDPropertyGroup` (coerce with `.to_dict()`) — Blender's own `rna_prop_ui.py` uses this coercion pattern. This matters only if you go Route A or post-process; the glTF exporter handles it for Route B.

**Coordinate conversion (if you ever need it in Python).** Correction matrix `Matrix.Rotation(-pi/2, 4, 'X')`; apply on the left of `obj.matrix_world`; `world.decompose()` → `(translation, rotation, scale)`. Or use `bpy_extras.io_utils.axis_conversion(from_forward='-Y', from_up='Z', to_forward='Z', to_up='Y').to_4x4()`. Use the `@` matrix-multiply operator, not `*`. Reorder the resulting Quaternion from `(w,x,y,z)` to `(x,y,z,w)` for three.js.

**Object type detection (verified enums).** `obj.type` ∈ `{'MESH','EMPTY','CAMERA','LIGHT',...}` (note `'LIGHT'`, not the pre-2.8 `'LAMP'`); light subtype via `obj.data.type` (`'POINT'|'SUN'|'SPOT'|'AREA'`). `obj.empty_display_type` ∈ `{'PLAIN_AXES','ARROWS','SINGLE_ARROW','CIRCLE','CUBE','SPHERE','CONE','IMAGE'}` with `obj.empty_display_size`. Collection membership via `obj.users_collection` (tuple of Collections); hierarchy via `obj.parent` / `obj.parent_type` (note `matrix_world` already bakes in parenting).

**Headless export for CI/watch-mode.** `blender scene.blend --background --python export.py` (add `--factory-startup` to rule out addon interference; `--python-exit-code` to surface script failures in a pipeline). Blender extensions like Monty Batch Exporter demonstrate the headless `--background --python` pattern for reproducible exports.

**GPU instancing.** If arenas repeat props heavily, enable the exporter's GPU-instances option (writes `EXT_mesh_gpu_instancing`); verify with `gltf-transform inspect` (look for `EXT_mesh_gpu_instancing` under `extensionsUsed`). Note three.js's GLTFLoader needs the instancing plugin/careful setup to build InstancedMesh (instances must share a parent and be created via Alt-D linked-duplicate in Blender); for ~5-10 hand-crafted arenas this may be premature — measure first.

## Recommendations

1. **Day 1 — lock conventions.** Fix up-axis (+Y Up), units (1 unit = 1 m, apply scale), naming/collection schema, and custom-property field names. Write these into a short CONVENTIONS.md in the repo. Threshold to revisit: only if you add a second content author.
2. **Build Route B importer first** (glTF→sim-document), validating against your existing generated schemas. Benchmark: a hand-made test arena round-trips from `.blend` → `.glb` → sim-document → rendered in-client with correct transforms.
3. **Add the minimal Blender panel + save_post auto-export.** Benchmark: placing a spawn point and saving updates the running client within ~1s with no manual steps.
4. **Wire the watcher/WebSocket hot-reload** into the dev client. Benchmark: edit-save-see loop under ~2s.
5. **Then, and only if pain appears, add**: schema-driven enum generation (mirror Blenvy's registry export), collision-primitive operators, and asset-browser prefab conventions. Trigger to invest in these: you find yourself hand-editing raw custom properties or duplicating prop-placement often.
6. **Do NOT build two-way sync** or a full in-house editor unless Blender's lack of in-engine gameplay preview becomes a measured bottleneck that hot-reload can't fix.
7. **Git hygiene**: LFS-track `*.blend` (and optionally `*.glb`); keep generated sim-document JSON in plain git as the reviewable diff; single-editor discipline avoids binary-merge hazards.

## Caveats

- The "~2–4 days" estimate assumes your sim-document format and asset-registry lookups are already stable; schema changes mid-build will extend it. It is an informed estimate, not a measured figure.
- three.js GLTFLoader `extras` → `userData` mapping has documented historical edge cases (primitive-typed extras, root-object extras, mesh/node precedence, single-primitive mesh collapse per issue #29768); budget a little time for importer robustness, and prefer node-level metadata.
- Blender API churn is real; pinning a Blender LTS version (as the "fastest exporter" author did with 4.5) and staying on it reduces addon maintenance.
- GPU-instancing round-trip to three.js is finicky and version-sensitive; treat as optional optimization, not v1.
- Some sources here are indie devlogs/vendor docs (Needle, rileyb3d, Blenvy, StraySpark) rather than formal references; they are consistent with each other and with primary Blender/three.js/Khronos docs, but they describe approaches, not guarantees for your exact stack.
