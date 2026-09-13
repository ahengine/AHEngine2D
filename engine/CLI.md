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

Errors use the same protocol on stderr and a non-zero, categorized exit code. `capabilities` is the machine-readable discovery contract. `schema list` and `schema show --name project` expose JSON schemas. Human-readable output is opt-in with `--format text`.

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
npm run ah2d -- entity create --file game.ah2d.json --scene main --id player --name Player --kind character --x 320 --y 180 --write
npm run ah2d -- entity create --file game.ah2d.json --scene main --data @player.json --write
npm run ah2d -- entity set --file game.ah2d.json --scene main player x 480 --write
npm run ah2d -- entity patch --file game.ah2d.json --scene main player '{"color":"#55aaff","tag":"Player"}' --write
npm run ah2d -- entity reparent --file game.ah2d.json --scene main weapon player --write
npm run ah2d -- entity reparent --file game.ah2d.json --scene main weapon --root --write
npm run ah2d -- entity clone --file game.ah2d.json --scene main player --deep --name "Player 2" --write
npm run ah2d -- entity delete --file game.ah2d.json --scene main player --cascade --write
```

Use `--root` to unparent an Entity explicitly; therefore an actual Entity whose ID is `root` remains addressable as a normal parent. Deleting an entity that has children requires either `--cascade` or `--reparent`. Cyclic parenting, dangling parents, duplicate IDs, and ambiguous names are rejected before writing.

## Components

Rigidbody and Collider use the editor's lossless top-level dialect. ECS-style `components.Rigidbody`, `components.Collider`, `components.Transform`, and custom components remain in their original storage location.

```text
npm run ah2d -- component list --file game.ah2d.json --scene main player
npm run ah2d -- component put --file game.ah2d.json --scene main player Rigidbody --write
npm run ah2d -- component patch --file game.ah2d.json --scene main player Rigidbody '{"mass":2,"gravityScale":0.8}' --write
npm run ah2d -- component put --file game.ah2d.json --scene main player Collider --value @collider.json --write
npm run ah2d -- component set --file game.ah2d.json --scene main player Collider friction 0.6 --write
npm run ah2d -- component delete --file game.ah2d.json --scene main player Collider --write
```

Transform and Name are required and cannot be removed.

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
