# AH2D game-development guide for coding agents

This document is the operational guide for an Agent building a game with AH2D Editor, AH2D Engine, and the AH2D CLI. Read `README.md` for the public data and runtime API, then follow this workflow for every project mutation.

## Mission and boundaries

An Agent may work in four distinct layers:

1. **Authoring data** — Universal AH2D Project JSON, scenes, entities, components, assets, prefabs, animations, and particles.
2. **Reusable engine code** — framework-neutral behavior in `engine/AH2DEngine.js`.
3. **Game code** — controllers, rules, UI, renderer mappings, content loading, and tests in the game project.
4. **Studio services** — the open local-trusted Next.js project APIs, comments, history, presence, and the Editor bridge under `src/`.

Keep game-specific logic outside `AH2DEdtior.html`. Modify the Editor only when the requested feature is an authoring workflow. Modify the Engine only when the behavior is reusable across games and runtimes.

Keep Studio attribution and collaboration concerns outside the framework-neutral Engine. The Studio does not protect a hosted authoring service: every network client that can reach it can mutate every project. A shipped game chooses its own identity and server architecture.

## Source-of-truth rules

- The source of truth is a Universal project with `format: "AH2D"`, `version: 4`, and a non-empty `scenes` array.
- New project documents declare `dataModel: { id: "ah2d.ecs", version: 1, componentSchemaVersion: 1 }`. Treat project version, data-model version, and component-schema version as separate compatibility axes; tolerate an otherwise valid legacy v4 document with no descriptor.
- `currentSceneId` selects the active Scene.
- Top-level `scene` is a compatibility mirror of the active Scene's `objects`; do not update it independently.
- Use stable Scene and Entity IDs in code. Do not bind gameplay to display names.
- `Engine.export()` and `ah2d ecs export` produce a lossy active ECS snapshot with version `3`. Never overwrite a Universal version `4` project with that snapshot.
- Preserve unknown fields. They may belong to game code, a renderer adapter, or a future Editor version. Use the CLI for lossless mutations because the current HTML Editor reconstructs several top-level sections during Load/Export.
- Components must be JSON-safe objects or arrays. Keep functions, `undefined`, non-finite numbers, DOM nodes, textures, sockets, class instances, and circular references in runtime-side Maps.
- Component keys use safe PascalCase. The Editor's authoring dialect uses flat `x/y/rot/sx/sy`, `rigidbody`, and `collider`; generic ECS components live under `components`.
- Authored `Transform.x/y/rotation/scaleX/scaleY` values are local to `parentId`. `Transform.world` is runtime-derived; do not persist or hand-edit it in a Universal Project.
- When the same component exists in multiple locations, `components.<canonical-or-alias>` has precedence over legacy/flat authoring fields. Preserve the selected `storage`/`provenance`; do not silently merge, delete, or canonicalize duplicate locations. Normal validation warns on conflicts and strict validation rejects them.
- Use the `authoring` schema profile for persisted project data, `runtime` for Engine/system values, and `snapshot` only for active ECS exports. Authoring normalization removes registered runtime-derived fields while preserving unknown JSON extensions.
- Compatibility validation may accept legacy numeric/boolean strings without coercing them; runtime decoding remains strict. Normalize authored scalar types before Engine load, and use `--strict` in CI.
- Top-level `postProcess` is project authoring data. Preserve effect IDs, unknown effect types, ordering, and unknown parameters unless the task explicitly changes them.
- A CLI-managed file uses a SHA-256 precondition (`--expect-sha256`). A Studio-managed project uses a numeric document `revision` (`expectedRevision`). These are separate concurrency domains and must not be substituted for one another.

## Required discovery before editing

Run these commands from the repository root:

```powershell
npm run ah2d -- doctor --pretty
npm run ah2d -- capabilities --pretty
npm run ah2d -- schema list --pretty
npm run ah2d -- schema show --component Transform --pretty
npm run check
npm run test:server
```

Do not scrape human help text to discover commands. Use the machine-readable result of `capabilities`, `schema list`, and `schema show --component <Type>`. The component descriptor includes aliases, all three profiles, defaults, runtime-only fields, and storage metadata.

For an existing game project:

```powershell
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
```

Record the `sha256` returned by `inspect`. Supply it to the final mutation using `--expect-sha256` so another process cannot be overwritten silently.

## Create a new game project

```powershell
npm run ah2d -- init --file game.ah2d.json --name "My Game" --scene-id main --scene-name "Main Menu"
npm run ah2d -- runtime set --file game.ah2d.json --runtime custom --write
npm run ah2d -- physics set --file game.ah2d.json --gravity-x 0 --gravity-y 980 --pixels-per-meter 100 --write
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
```

Suggested game layout:

```text
game/
├── index.html
├── game.ah2d.json
├── src/
│   ├── main.js
│   ├── input.js
│   ├── gameplay.js
│   ├── renderer.js
│   └── scenes.js
├── tests/
│   └── gameplay.test.js
└── operations/
    └── bootstrap.json
```

## Safe project-mutation loop

For every requested content change:

1. Inspect and validate the current file.
2. Resolve exact Scene and Entity IDs.
3. Express related changes as one batch.
4. Run the batch with `--dry-run --include-document`.
5. Review diagnostics and the resulting document.
6. Re-read the hash if the file may have changed.
7. Write once with `--expect-sha256`.
8. Run project validation and repository tests.

Example:

```powershell
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- apply --file game.ah2d.json --ops @operations/bootstrap.json --dry-run --include-document --pretty
npm run ah2d -- apply --file game.ah2d.json --ops @operations/bootstrap.json --write --expect-sha256 <sha256>
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
npm test
```

All `apply` operations are evaluated on an in-memory clone and written only if the entire batch succeeds.

## Collaborative Studio workflow

Projects under `.ah2d-data/collaboration` are server-managed records, not ordinary game files. Do not edit those JSON files directly and do not run the CLI against them while the Studio is running. Use the Project API so optimistic revision, Action History, SSE events, schema migration, and atomic persistence all remain consistent.

The minimum safe document mutation loop is:

1. Fetch `GET /api/projects/:projectId/document`; add optional actor-label headers if attribution is useful.
2. Record `data.revision` and preserve the entire Universal document, including unknown fields.
3. Compute a narrow JSON Patch or a complete replacement document.
4. Send `expectedRevision` and a new stable `clientMutationId`.
5. On `409 REVISION_CONFLICT`, fetch the latest document, merge deliberately, and submit a new mutation. Never blind-retry the stale payload.
6. Reconcile from `document.changed` SSE events, but treat the persisted document and revision as the source of truth.

Example JSON Patch request from a same-origin browser client:

```js
const actorHeaders = {
  'x-ah2d-actor-id': 'local-agent',
  'x-ah2d-actor-name': 'Local User'
};
const snapshot = await fetch(`/api/projects/${projectId}/document`, {
  headers: actorHeaders,
  cache: 'no-store'
}).then(response => response.json());

const result = await fetch(`/api/projects/${projectId}/document`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', ...actorHeaders },
  body: JSON.stringify({
    expectedRevision: snapshot.data.revision,
    clientMutationId: crypto.randomUUID(),
    operations: [
      { op: 'replace', path: '/scenes/0/name', value: 'Boss Arena' }
    ]
  })
}).then(response => response.json());

if (!result.ok && result.error?.code === 'REVISION_CONFLICT') {
  // Fetch again and perform a semantic merge; do not overwrite the newer document.
}
```

Use `PUT document` only when the Editor owns a complete, freshly based snapshot. Use `PATCH document` for targeted agent changes. JSON Patch supports `add`, `remove`, `replace`, and `test`; it does not support `move` or `copy`.

`clientMutationId` is idempotent per untrusted actor label while its history entry is retained. Reuse the same ID only when retrying the exact same logical mutation after an uncertain network response.

### Open local-trusted Studio rules

- Studio has no user setup, role or project membership. All projects, comments, history, realtime routes and mutations are available to every network client that can reach the server.
- Treat `x-ah2d-actor-id` and `x-ah2d-actor-name` as untrusted display labels only. For SSE, `actorId` and `actorName` query parameters serve the same purpose. Missing labels fall back to `Local User`.
- Never use actor labels for permission, ownership, moderation or security audit. Any client can spoof another label. `clientMutationId` scoped by actor label is only a deduplication aid.
- There are no account/member endpoints and no People-management workflow. Collaboration record v2 has no ownership or membership fields.
- Preserve support for reading `ah2d.collaboration/project-v1`; the next normal write must persist v2 without active membership data. Do not rewrite the store manually just to migrate it.
- Mutating browser requests must retain Same-Origin enforcement. This check does not protect the service from a direct client without an `Origin` header.
- Keep the Studio bound to loopback or a trusted private network. If it must be exposed, require network isolation, VPN or a reverse proxy with an independent access policy.
- `/api/editor/frame` and `/api/editor/engine` are public. The embedded Editor must still run without `allow-same-origin` in an opaque-origin sandbox. Preserve its restrictive CSP and validate `postMessage` by exact `event.source`, expected origin and message marker; never trust marker text alone.

### Realtime, comments, and history

Open `/api/projects/:projectId/events?clientId=<unique-tab-id>&actorId=<label>&actorName=<label>` before sending presence. A presence POST must use the same `clientId` and matching actor-label headers for correlation. That match is not a permission check. SSE delivery and presence are ephemeral; after reconnect, compare `revision` and `activitySequence` and fetch durable state.

Anchor comments with stable IDs where possible:

```js
{
  body: 'Move the hitbox two frames earlier.',
  anchor: {
    sceneId: 'boss-room',
    entityId: 'boss',
    path: '/animations/0/tracks/hitbox',
    frame: 18
  },
  clientMutationId: crypto.randomUUID()
}
```

Do not rewrite or delete Action History to conceal a mutation. The current history is a bounded product feature, not a compliance audit log. If a task requires immutable audit, implement a separate append-only production adapter and retention policy.

The development collaboration store, event hub, and presence are single-process implementations. Do not deploy multiple workers or serverless instances and claim realtime correctness. Follow `docs/DEPLOYMENT.md` before scaling or exposing the Studio beyond a trusted network.

## Post Process workflow

New projects contain six editable defaults: Bloom, Vignette, Color Adjust, Chromatic Aberration, Pixelate, and CRT. The Editor saves them at top-level `postProcess`; the Engine exposes the same data through `engine.postProcess`.

Runtime-side use:

```js
engine.load(project);
engine.postProcess.configure('bloom', { enabled: true, intensity: 0.45 });
engine.postProcess.configure('colorAdjust', { saturation: 1.15 });

const activeEffects = engine.postProcess.active;
project.postProcess = engine.postProcess.toJSON();
```

The Engine stores and normalizes the stack but a PixiJS, PhaserJS, or Custom host must map `activeEffects` to renderer-native filters/shaders. Do not claim a renderer applies a filter merely because it appears in `active`.

For a CLI-managed project, patch Post Process with the standard safe hash workflow:

```powershell
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- patch --file game.ah2d.json --patch @postprocess.patch.json --dry-run --include-document --pretty
npm run ah2d -- patch --file game.ah2d.json --patch @postprocess.patch.json --write --expect-sha256 <sha256>
```

For a Studio-managed project, apply the same JSON Patch through `/api/projects/:projectId/document` with `expectedRevision`; do not mix the CLI hash and Studio revision workflows.

## Scene workflow

```powershell
npm run ah2d -- scene list --file game.ah2d.json --pretty
npm run ah2d -- scene create --file game.ah2d.json --id level-1 --name "Level 1" --write
npm run ah2d -- scene clone --file game.ah2d.json --scene level-1 --id level-1-night --name "Level 1 Night" --write
npm run ah2d -- scene select --file game.ah2d.json --scene level-1 --write
npm run ah2d -- scene export --file game.ah2d.json --scene level-1 --out level-1.scene.json
npm run ah2d -- scene import --file game.ah2d.json --input level-1.scene.json --id level-1-copy --write
```

Use `--scene` or `--scene-id` for stable ID lookup. Use `--scene-name` only when the task explicitly supplies a display name and no stable ID is available. The CLI rejects ambiguous name matches.

When writing game code, call:

```js
engine.load(project);           // loads currentSceneId
engine.loadScene('level-1');    // reloads another authored Scene
```

Do not assume runtime mutations are persisted by `loadScene`; authoring changes belong in the Universal project.

## Entity and hierarchy workflow

```powershell
npm run ah2d -- entity list --file game.ah2d.json --scene level-1 --tree --format text
npm run ah2d -- entity tree --file game.ah2d.json --scene level-1 --world --pretty
npm run ah2d -- entity create --file game.ah2d.json --scene level-1 --id player --name Player --kind character --x 320 --y 180 --write
npm run ah2d -- entity create --file game.ah2d.json --scene level-1 --id sword --name Sword --parent player --x 32 --y 0 --write
npm run ah2d -- entity reparent --file game.ah2d.json --scene level-1 sword player --preserve-local --write
npm run ah2d -- entity reparent --file game.ah2d.json --scene level-1 sword vehicle --preserve-world --write
npm run ah2d -- entity reparent --file game.ah2d.json --scene level-1 sword --root --preserve-world --write
npm run ah2d -- entity clone --file game.ah2d.json --scene level-1 player --deep --name "Player 2" --write
npm run ah2d -- entity delete --file game.ah2d.json --scene level-1 temporary-parent --reparent --preserve-world --write
```

`parentId` is absent/null for a root or a stable Entity ID in the same Scene. Nesting is unrestricted, but every Scene must remain a finite forest. `--root` means unparent; the string `root` without the flag remains a valid Entity ID.

Reparent preserves the authored local Transform by default; use `--preserve-local` to be explicit. Use `--preserve-world` when an Editor-style reparent/detach must not move the Entity or its subtree visually. Never emulate preserve-world by copying world x/y: use the matrix conversion so parent rotation and scale are included. The two flags are mutually exclusive. A derived local write must update only the effective Transform provenance; never merge custom fields from lower-precedence legacy copies into canonical storage.

Cycle/self-parent/dangling-parent errors and preserve-world failures are atomic. A singular parent returns `E_NON_INVERTIBLE_TRANSFORM`; a required local shear outside the TRS schema returns `E_TRANSFORM_SHEAR`. Do not fall back to an approximate transform.

Use `--cascade` only when deleting the selected Entity and all descendants is explicitly intended. Use `--reparent` to retain direct children at the deleted Entity's parent. This deletion mode preserves each child's local Transform by default; pair it with `--preserve-world` when the retained child subtrees must not move. Transform-mode flags without `--reparent` are invalid, and every child conversion must succeed before any hierarchy mutation is committed.
Never combine `--cascade` and `--reparent`; the CLI and direct `entity.delete` apply operation reject that contradictory policy with `E_DELETE_MODE`.


Runtime hierarchy uses child-first argument order. Graph mutation preserves local space unless `preserveWorld` is true:

```js
engine.graph.attach('sword', 'player');
engine.reparent('sword', 'vehicle', { preserveWorld: true });
engine.graph.detach('sword', { preserveWorld: true });

engine.graph.traverse(null, (id, { depth, parentId, path }) => {
  inspect(id, depth, parentId, path);
});

engine.transform.setLocal('sword', { x: 24, rotation: 10 });
engine.transform.setWorld('sword', { x: 500, y: 220 });
const world = engine.transform.getWorldMatrix('sword');
```

Use `getLocal/getLocalMatrix` for authored-relative state and `getWorldTransform/getWorldMatrix` for derived state. The matrix is authoritative because nested rotated non-uniform scales can produce world shear. Use `engine.destroyEntity(id, { childPolicy })` for safe Runtime deletion; do not call low-level `ecs.destroy` on a graph node.

## Component workflow

Inspect the registered contract before mutating a built-in component:

```powershell
npm run ah2d -- schema list --pretty
npm run ah2d -- schema show --component Rigidbody --pretty
```

Add physics and game-specific data through components:

```powershell
npm run ah2d -- component put --file game.ah2d.json --scene level-1 player Rigidbody --write
npm run ah2d -- component patch --file game.ah2d.json --scene level-1 player Rigidbody '{"type":"dynamic","mass":1,"fixedRotation":true}' --write
npm run ah2d -- component put --file game.ah2d.json --scene level-1 player Collider --value '{"shape":"rectangle","width":64,"height":96,"friction":0.4}' --write
npm run ah2d -- component put --file game.ah2d.json --scene level-1 player PlayerController --value '{"speed":260,"jumpImpulse":420}' --write
npm run ah2d -- component get --file game.ah2d.json --scene level-1 player PlayerController --pretty
```

Use PascalCase component names. Prefer small data-only components:

```js
Health: { current: 100, maximum: 100 }
PlayerController: { speed: 260, jumpImpulse: 420 }
EnemyAI: { state: 'idle', detectionRadius: 300 }
Collectible: { score: 10, consumed: false }
```

The default registry is open-world, so an unknown PascalCase custom component under `components.<Type>` survives CLI reads, validation, migration, and writes with its unknown fields intact. If game code needs a stronger contract, call `engine.registerComponent(definition)` before `engine.load()` or `engine.createEntity()`, or pass a prepared `AH2D.ComponentSchemaRegistry` into the Engine. Define `authoring`, `runtime`, and `snapshot` schemas when they differ; otherwise omitted runtime/snapshot profiles inherit authoring. Add ordered migrations for every schema-version step and fail on a missing step rather than guessing.

CLI component mutations preserve the resolved provenance. If both `components.Rigidbody` and `rigidbody` exist, the former is effective and only it is changed or deleted; the legacy copy becomes effective only after the higher-precedence copy is removed. Review reported conflicts before writing. The standalone CLI knows the built-in registry and generic open-world custom values; it does not execute a game's registration code.

Implement behavior in game systems:

```js
function updateHealthSystem(engine) {
  for (const id of engine.ecs.query('Health', 'PendingDamage')) {
    const health = engine.ecs.get(id, 'Health');
    const damage = engine.ecs.get(id, 'PendingDamage');
    health.current = Math.max(0, health.current - damage.amount);
    engine.ecs.remove(id, 'PendingDamage');
    if (health.current === 0) engine.events.emit('game:entity-defeated', { id });
  }
}
```

## Gameplay loop rules

AH2D has built-in Transform, Animation clock, Physics, Camera, Lighting, Shadow, and Tilemap systems. It does not yet have an automatic Script/Behavior scheduler.

If gameplay must affect the current physics step, run it before `engine.update(dt)`:

```js
function frame(time) {
  const dt = calculateDelta(time);
  updateInputSystem(engine, dt);
  updateAISystem(engine, dt);
  updateCombatSystem(engine, dt);
  engine.update(dt);
  render(engine);
  requestAnimationFrame(frame);
}
```

An `engine:update` listener runs after the built-in systems and is best for observation, post-step state changes, telemetry, or data intended for the next frame:

```js
const unsubscribe = engine.events.on('engine:update', ({ dt, engine }) => {
  updateHUD(engine, dt);
});
```

Do not run both a manual loop and `engine.start()` for the same Engine. That would update physics twice per rendered frame.

Use `engine.destroyEntity(id, { childPolicy: 'reject' | 'cascade' | 'reparent' | 'detach', preserveWorld })` for Runtime deletion so Graph nodes, ECS components, descendant policy, and Transform caches stay synchronized. Treat `ecs.destroy(id)` as a low-level component-store operation, not an Entity lifecycle API.

## Physics rules

- `box2d` is the default requested backend and is executed by the bundled `planck` implementation. An unlocked `new Engine()` honors Universal Project `engine.physics`; a constructor `physics` option is an intentional fixed host override. Assert `engine.physics.backend === 'box2d'`, `implementation === 'planck'`, and `native === true` in physics-sensitive startup/tests.
- Project coordinates are pixels; native Box2D/Planck conversion uses `pixelsPerMeter`.
- Positive Y points down in the Editor convention.
- Rotation and angular velocity are degrees and degrees per second.
- An Entity with Collider but no Rigidbody is static.
- A `Collider` may be one object, an array, or a wrapper containing `colliders`/`shapes`; keep a stable ID on every fixture and make every explicit fixture ID unique within its Entity.
- Change scale with `engine.physics.setPixelsPerMeter(value)`, never by assigning `pixelsPerMeter` directly. Native bodies are rebuilt while their pixel-space state is preserved.
- Call `engine.update(0)` after load/create when direct `engine.physics.*` methods must be available immediately.
- Use fixed `dt` such as `1 / 60` in deterministic tests.
- Use collision category/mask fields for filtering instead of filtering events after contact resolution.
- Use Trigger colliders for pickups, exits, checkpoints, and damage zones.
- Use `physics:collisionstart/stay/end` and `physics:triggerenter/stay/exit`; do not run a second overlap detector beside native contacts.
- Select the dependency-independent solver only explicitly with Project `engine.physics: 'builtin'`, constructor `{ physics: 'builtin' }`, or CLI `--backend builtin`.

```js
engine.update(0);
engine.physics.applyImpulse('player', 0, -420);
engine.physics.setVelocity('platform', 80, 0);

let requestedScene = null;
const off = engine.events.on('physics:triggerenter', ({ a, b }) => {
  if ([a, b].includes('exit-zone')) requestedScene = 'level-2';
});

// Process requestedScene after engine.update() has returned.
```

For offline verification:

```powershell
npm run ah2d -- simulate --file game.ah2d.json --scene level-1 --steps 600 --dt 0.0166666667 --pretty
```

Use `--commit --write` only when the user explicitly wants the simulated final transforms and velocities written into the authoring project.

Planck-native escape hatches are `getNativeWorld()`, `getNativeBody(entityId)`, and `getNativeFixture(entityId, colliderId)`. Keep returned objects in Runtime code only; never serialize them into the Universal Project. The authored contract currently covers box/circle fixtures, not polygon/chain/joint definitions. Read [`docs/PHYSICS.md`](./docs/PHYSICS.md) before extending that contract.

## Renderer integration

### Custom Canvas

Read `Transform.world` and `Renderable` for every visible Entity. `Transform.world` is the authoritative derived `[a,b,c,d,e,f]` matrix and can be passed directly to Canvas 2D `setTransform` when the canvas uses project coordinates. Never render a nested Entity from its local `x/y/rotation/scale` alone.

Skip Entities with the `Hidden` component. Keep loaded `Image`, `Texture`, and GPU resources in a renderer-owned cache keyed by `assetId` or `imageSrc`.

### PixiJS

AH2D ships with PixiJS v8 and Planck as dependencies. In a plain Browser page load the scripts in this order: `pixi.min.js`, Pixi's CSP-safe `dist/packages/unsafe-eval.min.js` polyfill, `planck.min.js`, `AH2DDataModel.js`, then `AH2DEngine.js`. Despite its package name, that Pixi polyfill replaces generated `Function` paths with static synchronizers so Play Mode works without granting CSP `unsafe-eval`. With a bundler, import `pixi.js` plus `pixi.js/unsafe-eval` and pass its namespace explicitly; Engine resolves Planck in Node or accepts it as `box2d`.

```js
engine.useRuntime('pixijs', {
  PIXI,
  designWidth: 1920,
  designHeight: 1080,
  fit: 'contain',
  backgroundAlpha: 0,
  textureResolver(renderable, entityId, engine, PIXI) {
    return renderable.assetId
      ? PIXI.Assets.load(`/assets/${renderable.assetId}.png`)
      : null;
  }
});

engine.start(target, { restoreOnStop: true });
await engine.runtime.ready;
```

The adapter creates one `PIXI.Container` for every Scene Graph Entity, mirrors parent/child links, applies exact local matrices, and creates a centered `PIXI.Sprite` or a color `PIXI.Graphics` child for `Renderable`. It reconciles Entity creation, deletion, reparenting, `Hidden`, `Renderable.visible`, and layer order on render. Do not add a second host loop that duplicates this synchronization.

The default texture path is `Renderable.imageSrc`, then the matching `assetId` in `engine.document.assets`, then a directly usable `assetId`. Loading uses `PIXI.Assets.load()` and is asynchronous. A `textureResolver(renderable, entityId, engine, PIXI)` may return a Texture, a Promise for one, or a preloaded alias. Keep global `PIXI.Assets` ownership in the game host; the adapter deliberately does not destroy shared textures when an Entity disappears. Use `loadAssets: false` only when the host has preloaded every source.

Use `designWidth`/`designHeight` or `viewport: { width, height, fit }` for the logical viewport. Supported fit modes are `none`, `contain`, `cover`, and `stretch`. The active Camera matrix and zoom are applied automatically; a Camera component with `active: true` is the fallback when `engine.camera.active` is unset. The target resizes automatically unless `resizeTo: false` is passed. `backgroundAlpha`, `clearColor`, and `applicationOptions` configure application creation.

`engine.start()` returns synchronously while PixiJS v8 initializes asynchronously. Await `engine.runtime.ready` before reading the canvas or Display Tree. Pixi's own ticker is stopped; the AH2D Engine loop performs exactly one update and one render per Frame. `pause()` freezes the same mounted tree, `resume()` continues it, and `stop()` unmounts it. By default Stop restores the pre-Play ECS/Physics state as well as the original Universal document and active Scene, so subsequent `loadScene()` remains valid. Use `restoreOnStop: false`, `stop({ restore: false })`, or `snapshot: false` only deliberately.

If PixiJS is unavailable or initialization fails, `runtime.backend` reports `editor-bridge` and `runtime.native` is false. Do not claim native rendering based only on `runtime.name`. Handle `runtime:error`, `runtime:fallback`, and `runtime:textureError` when the host needs error UI or recovery.

PixiJS currently maps Transform, Renderable, Hidden, hierarchy, Camera, and resize. Animation frame slicing, Particle rendering, Light/Shadow, Tilemap drawing, and Post Process filters remain host responsibilities.

### PhaserJS

Phaser remains host-owned. Selecting `phaserjs` reports native availability when `Phaser.Game` exists, but the project must create and cache Game Objects, synchronize ECS Transform/Renderable state, remove stale objects, and apply Camera, Light, Shadow, Animation, Particle, Tilemap, and Post Process behavior.

```js
engine.useRuntime('phaserjs', { Phaser: window.Phaser });
console.log(engine.runtime.backend); // phaserjs or editor-bridge
```

## Animation, prefab, and particle rules

- The built-in AnimationSystem advances `{ playing, time, duration, speed }`; the renderer maps time to frames.
- Animation event dispatch, sprite-sheet slicing, interpolation, and hitbox tracks must be implemented by game code until the serialized asset contract is extended.
- The current `prefab` output is an authoring workspace, not a complete variant/override system. Do not infer reusable prefab definitions that are absent from JSON.
- Current Particle JSON is emitter configuration. A runtime particle renderer must interpret it; live preview particles are not exported.
- Do not invent missing fields during a read-only task. When a requested feature requires a schema extension, update validation, migration, Editor export/load, CLI, runtime consumption, tests, and docs together.

## Runtime and headless testing

Browser bootstrap:

```html
<!-- Required before the Engine when the native PixiJS runtime is selected. -->
<script src="./node_modules/pixi.js/dist/pixi.min.js"></script>
<!-- CSP-safe static synchronizers required when unsafe-eval is forbidden. -->
<script src="./node_modules/pixi.js/dist/packages/unsafe-eval.min.js"></script>
<!-- Required before the Engine for native Box2D-compatible physics. -->
<script src="./node_modules/planck/dist/planck.min.js"></script>
<script src="./engine/AH2DDataModel.js"></script>
<script src="./engine/AH2DEngine.js"></script>
```

Node bootstrap:

```js
global.window = global;
require('./engine/AH2DEngine.js');
const engine = new global.AH2D.Engine(); // Resolves the installed `planck` package.

if (!engine.physics.native) throw new Error('Native Box2D backend is required');
```

Recommended test layers:

1. **Project validation** — CLI schema and graph validation.
2. **Deterministic simulation** — fixed-step CLI or headless Engine.
3. **Gameplay unit tests** — pure system functions operating on ECS data.
4. **Renderer adapter tests** — Entity creation/removal and Transform synchronization.
5. **Editor contract tests** — only when Editor authoring behavior changed.

Run:

```powershell
npm run check
npm test
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
```

## Engine changes

When a task requires changing `engine/AH2DEngine.js`:

1. Preserve the framework-neutral Universal data model.
2. Keep the shared `ah2d.ecs` registry, all three component profiles, storage/provenance resolution, validation, and migration behavior aligned across Engine and CLI.
3. Keep Custom, PixiJS, and PhaserJS runtime selection functional.
4. Preserve the built-in deterministic physics fallback.
5. Add or update `engine/AH2DEngine.test.js` and the focused data-model/CLI tests when applicable.
6. Update `README.md` when the public API or serialized contract changes.
7. Update CLI schema discovery, migration, and validation when project data changes.
8. Bump versions only when the task explicitly defines a release/versioning change or repository policy requires it.

Do not silently convert project version `4` to the ECS snapshot version `3`.

## Completion checklist

A game-development task is complete only when all applicable items are true:

- The requested behavior exists in game code, Engine, Editor, or authoring data at the correct layer.
- Stable IDs are used and hierarchy invariants remain valid.
- Runtime choice is explicit and renderer-host responsibilities are implemented.
- Physics data validates and deterministic behavior is tested where relevant.
- Universal project data remains version `4` and unknown fields are preserved.
- The `dataModel` descriptor and component profile/version changes are deliberate, and Universal data has not been confused with snapshot version `3`.
- Component storage provenance, `components.*` precedence, legacy copies, and unknown custom components are preserved unless explicit migration requirements say otherwise.
- `scene` mirrors the active Scene.
- Post Process effect IDs, ordering, custom parameters, and project-specific values are preserved.
- Dry-run was reviewed before material project writes.
- Final writes used `--expect-sha256` when working concurrently.
- Studio document writes used the latest `expectedRevision` and an idempotent `clientMutationId`.
- Studio exposure matches the open local-trusted model, and actor labels are never treated as access control.
- Durable document/history reconciliation is performed after SSE reconnect; presence is treated as ephemeral.
- `npm run check` passes.
- `npm test` passes.
- `npm run build` passes when Next.js Studio code changed.
- The project passes `validate --engine`.
- Documentation reflects any new public API or serialization behavior.

## References

- `README.md` — project output and game-programming guide.
- `engine/README.md` — Engine architecture and physics summary.
- `engine/CLI.md` — complete CLI reference.
- `docs/COLLABORATION.md` — public project APIs, actor attribution, schema migration, SSE, comments, history, and presence.
- `docs/DEPLOYMENT.md` — network isolation, the single-process boundary, and production adapter guidance.
- `AGENTS.md` — compact repository-level Agent instructions.
