# AH2D Engine CLI

The AH2D CLI is designed for both coding agents and humans. It edits Universal AH2D project JSON directly and losslessly. The Engine is loaded only for runtime validation, physics simulation, and explicit ECS snapshot export. Native Box2D execution is provided by the bundled Planck implementation; the AH2D deterministic solver remains available as an explicit fallback.

## Start

Install the repository dependencies first and use the Node.js version declared by `package.json`.

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

The `sceneGraph` capability declares `parentId` storage, local authoring Transform space, the derived world-matrix shape, the default Reparent mode, both preservation flags, and the tree/world inspection command. `prefabs` declares canonical storage, expanded-instance behavior, RFC 6901 override paths, operations, and root-placement rules. `skeletons` declares the four canonical Components, reference scope, Bone hierarchy/IK-chain rules, Skin weights, Runtime-only outputs, and animation Track types. `enums.physicsBackend` and `options.physicsBackend` expose the supported Physics execution backends and the commands accepting `--backend`. Agents should discover these fields instead of assuming Editor behavior.

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
npm run ah2d -- schema show --name prefabAsset --pretty
npm run ah2d -- schema show --component Transform --pretty
npm run ah2d -- schema show --component Skeleton --pretty
npm run ah2d -- schema show --component Bone --pretty
npm run ah2d -- schema show --component IK --pretty
npm run ah2d -- schema show --component Skin --pretty
npm run ah2d -- schema show component:Body --pretty
```

`schema list` returns the document schemas (`project`, `prefabAsset`, `operation`, `batch`) and all built-in component types. `schema show --component TYPE` returns the canonical type, aliases, schema version, required/removable/tag flags, defaults, `authoring`/`runtime`/`snapshot` schemas, runtime-only fields, and storage metadata. Aliases resolve to the canonical descriptor, so `component:Body` reports `component:Rigidbody`.

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

Skeleton rigs use the same generic Entity/Component commands; create all related Entities and Components in one atomic `apply` batch so the document never lands in a half-wired state. Semantic validation checks Skeleton ancestry/root, contiguous IK chains, Skin weights, Scene/Prefab scope, and per-Instance source-ID resolution. See [`../docs/SKELETONS.md`](../docs/SKELETONS.md) for the complete contract and examples.

## Prefab Assets, Instances, and overrides

Reusable definitions live in top-level `prefabs`. Each Asset owns stable source-Entity IDs and a revision:

```json
{
  "id": "crate-prefab",
  "name": "Crate",
  "rootEntityId": "crate-root",
  "revision": 1,
  "entities": [
    { "id": "crate-root", "name": "Crate", "x": 0, "y": 0 },
    { "id": "crate-lid", "name": "Lid", "parentId": "crate-root", "x": 0, "y": -12 }
  ]
}
```

Creating an Asset from a Scene Entity captures its complete subtree, normalizes the Asset root's effective local Transform to identity, and connects the existing Scene subtree as the first expanded instance without moving it. Instantiating clones every source Entity, remaps internal `parentId` values, and gives every member a `PrefabInstance` component containing `prefabId`, `sourceEntityId`, `instanceRootId`, `prefabRevision`, and `overrides`.

```text
npm run ah2d -- prefab asset list --file game.ah2d.json --pretty
npm run ah2d -- prefab asset get --file game.ah2d.json crate-prefab --pretty
npm run ah2d -- prefab asset create --file game.ah2d.json --scene main --entity crate --id crate-prefab --name Crate --dry-run --include-document
npm run ah2d -- prefab asset create --file game.ah2d.json --scene main --entity crate --id crate-prefab --write --expect-sha256 <sha256>
npm run ah2d -- prefab instantiate --file game.ah2d.json --scene main crate-prefab --id crate-2 --parent props --x 480 --y 240 --write
npm run ah2d -- prefab unpack --file game.ah2d.json --scene main crate-2 --write
```

The external `parentId` and complete local `Transform` are independent placement state on an instance root. `--parent`, `--x`, and `--y` initialize part of that placement during instantiation. Asset synchronization never rewrites the root's placement. Edit root position, rotation, and scale with the ordinary Entity/Transform commands, not with Prefab overrides.

An override key is a canonical RFC 6901 pointer relative to one expanded Entity. Its value is an explicit JSON Patch-style record: `{ "op": "add", "value": ... }`, `{ "op": "replace", "value": ... }`, or `{ "op": "remove" }`. This keeps removal distinct from setting a real JSON `null` value. Dot paths are accepted by `override set` for convenience but are stored as canonical pointers. Entity `id`, `parentId`, the legacy `prefab` projection, and `components.PrefabInstance` cannot be overridden.

Override paths within one member never overlap. Setting an exact or ancestor path replaces that record and clears covered descendants. When an existing ancestor override already owns the requested nested path, the CLI mutates and rebases that owning record so sibling differences remain tracked rather than becoming silent local state. Mutation results expose `storedPath` when it differs from the requested `path`. `--remove` stores an explicit `remove` only when the Asset owns the source path. If the path was introduced only by a local `add`, `--remove` deletes that local value and clears its overlapping record instead of persisting an invalid removal.

```text
npm run ah2d -- prefab override set --file game.ah2d.json --scene main crate-2-child --path /color --value '"#ff8844"' --write
npm run ah2d -- prefab override set --file game.ah2d.json --scene main crate-2-child --path /components/Health/temporary --remove --write
npm run ah2d -- prefab override inspect --file game.ah2d.json --scene main crate-2-child --pretty
npm run ah2d -- prefab override inspect --file game.ah2d.json --scene main crate-2 --all --pretty
npm run ah2d -- prefab override revert --file game.ah2d.json --scene main crate-2-child --path /color --write
npm run ah2d -- prefab override apply --file game.ah2d.json --scene main crate-2-child --path /color --write
npm run ah2d -- prefab override apply --file game.ah2d.json --scene main crate-2 --all --write
```

`override inspect` reports the Asset source state, current instance state, and stored operation for every override. `revert` restores the source value (or removes a property absent from the Asset) and clears the record. `apply` executes the stored canonical operation against the Asset, increments its revision, clears the applied record, and synchronizes other connected instances. An exact override or ancestor override owns its complete branch and blocks that Asset change. Descendant overrides retain their effective values and are rebased against the new Asset source while unaffected siblings still synchronize. If an Asset edit removes or retypes an ancestor needed by a descendant override, the CLI preserves the previous effective branch and promotes it to one valid override on that ancestor. Array insertion/removal reindexes later override pointers; an override on an element removed by the Asset is promoted to ownership of the complete array so the Instance remains reconstructable.

A direct `add` at `/components/<Type>` may materialize a missing `components` map on a compact Asset source. This exception exists only for adding one complete Component. Deeper paths such as `/components/Health/current` still require their parent Component to exist, preserving strict pointer behavior.

Revision synchronization is atomic per expanded Instance group. Only a group whose every member was at the Asset's previous revision is synchronized and advanced to the new revision. A stale group is neither partially mutated nor stamped current; it remains stale until a full compatible synchronization is explicitly performed.

Connected instance members are lifecycle-managed. Ordinary Entity and Component mutations cannot rename, patch, clone, delete, reparent, or add children inside a connected instance, and non-placement properties must go through `prefab override set`. Unpack first when a structural edit is intended. The only direct exceptions are the complete local `Transform` and external `parentId` of the instance root; use Transform commands and `entity reparent` for those. `capabilities.prefabs.connectedMutationPolicy` exposes this rule for agents. Whole-Scene clone remains supported and remaps each copied `instanceRootId` with its copied Scene Entity IDs. Low-level `patch` and generic resource writes remain explicit raw escape hatches and are responsible for preserving a valid Prefab contract.

Update can merge metadata/definition data through `--patch`, or recapture a Scene subtree with `--entity`. It increments the Asset revision and rebuilds expanded Instance groups that were current at the previous revision while preserving their recorded overrides, unknown marker extensions, and root placement. Stale groups are skipped and reported through `synchronized.staleInstanceCount`. Removing source members removes their generated instance members from synchronized groups; external children of a removed member are retained under the instance root.

```text
npm run ah2d -- prefab asset update --file game.ah2d.json crate-prefab --patch @crate-prefab.patch.json --write
npm run ah2d -- prefab asset update --file game.ah2d.json crate-prefab --scene main --entity updated-crate --write
npm run ah2d -- prefab asset delete --file game.ah2d.json crate-prefab --write
npm run ah2d -- prefab asset delete --file game.ah2d.json crate-prefab --unpack-instances --write
```

Asset deletion rejects live connected instances with `E_PREFAB_IN_USE`. The explicit `--unpack-instances` mode keeps their concrete Scene Entities and removes only their Prefab markers before deleting the Asset. Legacy top-level `prefab` workspace data is preserved and remains available through raw `resource` reads, but lifecycle commands intentionally do not reinterpret it as reusable definitions. Creating the first reusable Asset adds canonical `prefabs` without deleting the legacy field. Use the domain commands for lifecycle edits rather than raw `resource put`, because the latter does not connect or synchronize instances.

## Runtime and physics

```text
npm run ah2d -- runtime get --file game.ah2d.json
npm run ah2d -- runtime set --file game.ah2d.json --runtime phaserjs --write
npm run ah2d -- physics get --file game.ah2d.json
npm run ah2d -- physics set --file game.ah2d.json --gravity-x 0 --gravity-y 980 --pixels-per-meter 100 --write
npm run ah2d -- physics set --file game.ah2d.json --backend box2d --write
```

New projects request `box2d`, record the native `box2d` backend, and identify `planck` as the implementation. `physics get` reports `requested`, `backend`, `implementation`, and `native` independently, along with gravity and pixels per metre. `physics set --backend builtin` deliberately changes the project's requested backend to the AH2D fallback; use `--backend box2d` to switch it back.

Runtime commands honor `engine.physics` by default. `validate --engine`, `simulate`, and `ecs export` also accept an execution-only `--backend box2d|builtin` override. The override does not modify the Universal Project. Their results include this normalized descriptor:

```json
{
  "requested": "box2d",
  "backend": "box2d",
  "implementation": "planck",
  "native": true
}
```

Use `--backend builtin` when a test specifically requires the dependency-independent AH2D solver. Invalid backend names fail with `E_PHYSICS_BACKEND` rather than silently selecting a different implementation.

## Physics simulation

Simulation is read-only unless `--commit` is paired with an explicit mutation mode. It uses the selected Scene, project gravity and pixels-per-metre setting. By default it honors the project's requested backend, so a normal new project runs native Box2D through Planck. Fixed `dt` produces repeatable runs for the same implementation; select the AH2D deterministic fallback explicitly when that exact solver is required.

```text
npm run ah2d -- simulate --file game.ah2d.json --scene main --steps 120 --dt 0.0166666667 --pretty
npm run ah2d -- simulate --file game.ah2d.json --scene main --backend builtin --steps 120 --dt 0.0166666667 --pretty
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

Resources are accessible with `resource list|get|put|delete` for `assets`, `folders`, `prefabs`, `animations`, and `particles`. Prefer the `prefab` domain commands for reusable Prefab lifecycle changes; generic resource writes are intentionally raw.

## ECS export and migration

```text
npm run ah2d -- migrate --file legacy.json --out project-v4.json
npm run ah2d -- validate --file project-v4.json --strict --warnings-as-errors --engine
npm run ah2d -- validate --file project-v4.json --engine --backend builtin
npm run ah2d -- ecs export --file project-v4.json --scene main --out main.ecs.json
npm run ah2d -- ecs export --file project-v4.json --scene main --backend builtin --out main.builtin.ecs.json
```

`ecs export` is intentionally lossy and exports only the chosen runtime Scene. It never replaces the Universal project automatically.

`validate` applies the `authoring` component profile, reports exact JSON Pointers, checks JSON safety and registered schemas, and detects duplicate storage conflicts. Add `--strict` to promote compatibility conflicts (and other strict diagnostics) to errors; add `--warnings-as-errors` when CI must reject every warning. `--engine` additionally verifies every Scene with the requested Physics backend and reports the actual backend/implementation used.

Default compatibility validation accepts legacy numeric/boolean strings for schema inspection but does not coerce them. `--strict` rejects those values, and Engine runtime decoding is always strict; normalize authored values to real JSON numbers/booleans before execution.

`migrate` upgrades the project container and Scene layout while preserving unknown top-level, Entity, and component data. It does not canonicalize component storage, discard legacy spellings, or inject the data-model descriptor into an already-version-4 document solely because the descriptor is absent. The Engine registry API runs component-schema migrations as ordered functions from each schema version to the next; a missing step fails rather than guessing a conversion.
