# AH2D Engine CLI

The AH2D CLI is designed for both coding agents and humans. It edits Universal AH2D project JSON directly and losslessly. The Engine is loaded only for runtime validation, deterministic physics simulation, and explicit ECS snapshot export.

## Start

No dependency install is required; Node.js 18 or newer is enough.

```text
npm run ah2d -- capabilities --pretty
npm run ah2d -- init --file game.ah2d.json --name "My Game"
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
```

After `npm link`, the same commands can use the shorter `ah2d` executable.

## Agent protocol

stdout is JSON by default:

```json
{
  "protocol": "ah2d.cli/v1",
  "ok": true,
  "command": "scene.list",
  "changed": false,
  "data": {},
  "diagnostics": [],
  "meta": {
    "file": null,
    "sha256Before": null,
    "sha256After": null
  }
}
```

Errors use the same protocol on stderr and a non-zero, categorized exit code. `capabilities` is the machine-readable discovery contract. It reports `dataModel`, the three component-schema profiles, registry types, `unknownComponents: "preserve"`, and `precedence: "components"`. Human-readable output is opt-in with `--format text`.

The `sceneGraph` capability declares `parentId` storage, local authoring Transform space, the derived world-matrix shape, the default Reparent mode, both preservation flags, and the tree/world inspection command. Agents should discover these fields instead of assuming Editor behavior.

Exit codes:

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 2 | CLI usage error |
| 3 | File or JSON I/O error |
| 4 | Project/schema validation error |
| 5 | Requested item not found |
| 6 | Conflict, unsafe edit, or optimistic-lock failure |
| 7 | Engine/runtime failure |
| 70 | Unexpected internal failure |

## Safe mutation model

Every mutation requires one explicit mode:

- `--write`: atomically replace `--file`.
- `--out FILE`: write a new file.
- `--print-document`: return the changed document without writing.
- `--dry-run`: validate the change without writing; add `--include-document` to receive the result.

Use the hash returned by `inspect` for optimistic concurrency:

```text
npm run ah2d -- inspect --file game.ah2d.json
npm run ah2d -- runtime set --file game.ah2d.json --runtime pixijs --write --expect-sha256 <sha256>
```

Writes use a same-directory temporary file and atomic rename. `--backup` also keeps `<file>.bak`; `--mkdir` creates a missing output directory.

## Scene commands

```text
npm run ah2d -- scene list --file game.ah2d.json --pretty
npm run ah2d -- scene create --file game.ah2d.json --id level-2 --name "Level 2" --activate --write
npm run ah2d -- scene clone --file game.ah2d.json --scene level-2 --id level-2-night --name "Level 2 Night" --write
npm run ah2d -- scene rename --file game.ah2d.json --scene level-2 --name "Forest" --write
npm run ah2d -- scene select --file game.ah2d.json --scene level-2 --write
npm run ah2d -- scene delete --file game.ah2d.json --scene level-2-night --write
npm run ah2d -- scene export --file game.ah2d.json --scene level-2 --out level-2.scene.json
npm run ah2d -- scene import --file game.ah2d.json --input level-2.scene.json --id imported-level --write
```

Selectors are IDs by default. Name lookup must be explicit with `--scene-name "Level 2"`, which reports ambiguity instead of guessing.

## Entity and hierarchy commands

```text
npm run ah2d -- entity list --file game.ah2d.json --scene main --tree --format text
npm run ah2d -- entity tree --file game.ah2d.json --scene main --world --pretty
npm run ah2d -- entity create --file game.ah2d.json --scene main --id player --name Player --kind character --x 320 --y 180 --write
npm run ah2d -- entity create --file game.ah2d.json --scene main --data @player.json --write
npm run ah2d -- entity set --file game.ah2d.json --scene main player x 480 --write
npm run ah2d -- entity patch --file game.ah2d.json --scene main player '{"color":"#55aaff","tag":"Player"}' --write
npm run ah2d -- entity reparent --file game.ah2d.json --scene main weapon player --preserve-local --write
npm run ah2d -- entity reparent --file game.ah2d.json --scene main weapon vehicle --preserve-world --write
npm run ah2d -- entity reparent --file game.ah2d.json --scene main weapon --root --preserve-world --write
npm run ah2d -- entity clone --file game.ah2d.json --scene main player --deep --name "Player 2" --write
npm run ah2d -- entity delete --file game.ah2d.json --scene main player --cascade --write
npm run ah2d -- entity delete --file game.ah2d.json --scene main container --reparent --preserve-world --write
```

Every authored Transform is local to its `parentId`; a root Entity's local and world matrices are equal. World state is derived by multiplying matrices from the root to the Entity and is not persisted in the authoring Transform. `entity tree --world` (equivalent to `entity list --tree --world`) returns DFS order plus `depth`, the stable-ID `path`, `childCount`, `localTransform`, `localMatrix`, `worldMatrix`, and `worldPosition`.

`entity reparent` keeps the local Transform by default for backward compatibility; `--preserve-local` makes that choice explicit. The Entity can therefore move in world space when the parent changes. `--preserve-world` snapshots the old world matrix, assigns the new parent, and derives a new local Transform so the Entity and its complete subtree stay visually fixed. The same option works with `--root`.

`--preserve-local` and `--preserve-world` are mutually exclusive. Preserve-world is rejected atomically with `E_NON_INVERTIBLE_TRANSFORM` when the new parent's world matrix is singular, or `E_TRANSFORM_SHEAR` when an exact local result would require shear that the current `x/y/rotation/scaleX/scaleY` contract cannot represent.
Preserve-world rewrites only the selected Transform provenance. It does not promote or merge custom fields from conflicting lower-precedence legacy copies into the effective component.


Use `--root` to unparent an Entity explicitly; therefore an actual Entity whose ID is `root` remains addressable as a normal parent. `parentId` must be null/absent or the non-empty stable ID of another Entity in the same Scene. Nesting may be arbitrarily deep, but the result must remain a finite tree/forest. Deleting an Entity that has children requires either `--cascade` or `--reparent`. Self-parenting, cyclic parenting, dangling parents, duplicate IDs, and ambiguous names are rejected before writing.
`--cascade` and `--reparent` are mutually exclusive delete modes. Supplying both is rejected with `E_DELETE_MODE` before mutation, including inside an atomic `apply` batch.

With `entity delete --reparent`, direct children preserve their local Transforms by default. Add `--preserve-world` to recompute every direct child's local Transform before removing the intermediate parent, keeping each retained subtree visually fixed. Transform-mode flags without `--reparent` are rejected with `E_DELETE_TRANSFORM_MODE`; all child conversions are prepared before mutation, so one singular/sheared failure rolls back the complete operation.


For an atomic `apply` batch, use `{ "op": "entity.reparent", "sceneId": "main", "entityId": "weapon", "parentId": "player", "preserveWorld": true }`. Omission of `preserveWorld` means preserve-local.

## Schema discovery

Use the schema commands instead of scraping `--help` or copying assumptions from a renderer:

```text
npm run ah2d -- schema list --pretty
npm run ah2d -- schema show --name project --pretty
npm run ah2d -- schema show --component Transform --pretty
npm run ah2d -- schema show component:Body --pretty
```

`schema list` returns the document schemas (`project`, `operation`, `batch`) and all built-in component types. `schema show --component TYPE` returns the canonical type, aliases, schema version, required/removable/tag flags, defaults, `authoring`/`runtime`/`snapshot` schemas, runtime-only fields, and storage metadata. Aliases resolve to the canonical descriptor, so `component:Body` reports `component:Rigidbody`.

## Components

Universal Project version `4` is the authoring source of truth. New projects declare `dataModel: { id: "ah2d.ecs", version: 1, componentSchemaVersion: 1 }`; the version-`3` output of `ecs export` is a separate, lossy active-runtime snapshot.

Component reads resolve `components.<CanonicalName>` first, then registered aliases in `components`, then legacy authoring locations. For example, `components.Rigidbody` wins over `components.RigidBody`, `components.Body`, `rigidbody`, and `rigidBody`; `components.Transform` wins over `transform` and flat `x/y/rot/sx/sy`. `component get` and `component list` report `storage`, `provenance`, and conflicting lower-precedence values; mutation results report `storage` and `provenance`.

Component writes preserve the selected provenance. Therefore patching a value originally stored at `components.Rigidbody` keeps it there, while patching a legacy `rigidbody` keeps that spelling/location whenever it can represent the value. Other legacy copies, custom fields, unknown components, and unknown top-level data are not rewritten. Conflicting copies produce `E_COMPONENT_CONFLICT`: a warning in normal validation and an error under `--strict`.

Compact flat `Transform` and `Renderable` are projections over Entity fields, so a write preserves omitted sibling properties there; a write to `components.*` replaces the component object. Use `component patch` for field-wise changes and canonical storage when full replace semantics must be independent of the Entity projection.

```text
npm run ah2d -- component list --file game.ah2d.json --scene main player
npm run ah2d -- component put --file game.ah2d.json --scene main player Rigidbody --write
npm run ah2d -- component patch --file game.ah2d.json --scene main player Rigidbody '{"mass":2,"gravityScale":0.8}' --write
npm run ah2d -- component put --file game.ah2d.json --scene main player Collider --value @collider.json --write
npm run ah2d -- component set --file game.ah2d.json --scene main player Collider friction 0.6 --write
npm run ah2d -- component delete --file game.ah2d.json --scene main player Collider --write
```

Transform and Name are required and cannot be removed.

Values must be JSON-safe objects or arrays, and component keys must be safe PascalCase names. The built-in registry is open-world: an unregistered custom type such as `Health` or `PlayerController` is accepted under `components.<Type>`, validated with the generic object/array schema, and preserved losslessly. Register its stronger schema with the Engine when runtime code needs defaults, normalization, aliases, or migrations; the standalone CLI exposes its built-in registry and does not load arbitrary game code.

## Runtime and physics

```text
npm run ah2d -- runtime get --file game.ah2d.json
npm run ah2d -- runtime set --file game.ah2d.json --runtime phaserjs --write
npm run ah2d -- physics get --file game.ah2d.json
npm run ah2d -- physics set --file game.ah2d.json --gravity-x 0 --gravity-y 980 --pixels-per-meter 100 --write
```

## Deterministic simulation

Simulation is read-only unless `--commit` is paired with an explicit mutation mode. It uses the selected Scene, project gravity and pixels-per-metre setting, and the Engine's built-in fixed-step physics.

```text
npm run ah2d -- simulate --file game.ah2d.json --scene main --steps 120 --dt 0.0166666667 --pretty
npm run ah2d -- simulate --file game.ah2d.json --scene main --steps 120 --dt 0.0166666667 --commit --write
```

Only final Transform/Rigidbody state is merged back into the selected Scene. Other Scenes, assets, prefabs, animations, particles, and unknown data are preserved.

## Atomic batch operations

`apply` executes all domain operations on an in-memory clone, validates the complete result, and writes only if every operation succeeds.

```json
[
  { "op": "scene.create", "id": "arena", "name": "Arena", "activate": true },
  { "op": "entity.create", "sceneId": "arena", "id": "player", "name": "Player", "kind": "character", "x": 320, "y": 180 },
  { "op": "component.put", "sceneId": "arena", "entityId": "player", "component": "Rigidbody" },
  { "op": "component.patch", "sceneId": "arena", "entityId": "player", "component": "Rigidbody", "patch": { "mass": 2 } }
]
```

```text
npm run ah2d -- apply --file game.ah2d.json --ops @operations.json --write
```

## Generic data access

Use `query` for RFC 6901 JSON Pointer reads, `patch` for RFC 6902 JSON Patch, and `project patch` for RFC 7396 JSON Merge Patch.

```text
npm run ah2d -- query --file game.ah2d.json --pointer /engine/gravity
npm run ah2d -- patch --file game.ah2d.json --patch @changes.patch.json --dry-run --include-document
npm run ah2d -- project patch --file game.ah2d.json --patch '{"meta":{"name":"Renamed"}}' --write
```

Resources are accessible with `resource list|get|put|delete` for `assets`, `folders`, `prefabs`, `animations`, and `particles`.

## ECS export and migration

```text
npm run ah2d -- migrate --file legacy.json --out project-v4.json
npm run ah2d -- validate --file project-v4.json --strict --warnings-as-errors
npm run ah2d -- ecs export --file project-v4.json --scene main --out main.ecs.json
```

`ecs export` is intentionally lossy and exports only the chosen runtime Scene. It never replaces the Universal project automatically.

`validate` applies the `authoring` component profile, reports exact JSON Pointers, checks JSON safety and registered schemas, and detects duplicate storage conflicts. Add `--strict` to promote compatibility conflicts (and other strict diagnostics) to errors; add `--warnings-as-errors` when CI must reject every warning. `--engine` additionally verifies that the selected project can be loaded by the Engine.

Default compatibility validation accepts legacy numeric/boolean strings for schema inspection but does not coerce them. `--strict` rejects those values, and Engine runtime decoding is always strict; normalize authored values to real JSON numbers/booleans before execution.

`migrate` upgrades the project container and Scene layout while preserving unknown top-level, Entity, and component data. It does not canonicalize component storage, discard legacy spellings, or inject the data-model descriptor into an already-version-4 document solely because the descriptor is absent. The Engine registry API runs component-schema migrations as ordered functions from each schema version to the next; a missing step fails rather than guessing a conversion.
