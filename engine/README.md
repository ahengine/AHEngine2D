# AH2D Engine

For the complete Universal Editor output contract and game-programming examples, see [`../README.md`](../README.md). For the coding-Agent workflow, see [`../Agent.md`](../Agent.md).

AH2D keeps editor data independent from a specific renderer. The editor can preview the same universal scene through the `pixijs`, `phaserjs`, or `custom` runtime adapter. If PixiJS or Phaser is not loaded, the selected adapter runs through the editor Canvas compatibility bridge and reports that backend explicitly.

## Stack

- Scene Graph with cycle-safe nested parent/child relationships
- Entity Component System (ECS)
- Transform, Camera, Lighting, Shadow, Animation, and Tilemap systems
- Native Box2D-compatible backend through Planck with pixel/metre conversion
- Deterministic built-in 2D physics backend available by explicit selection
- Runtime adapters for PixiJS, PhaserJS, and custom hosts
- Editor bridge for `AH2DEdtior.html`
- Multi-Scene project loading and runtime Scene switching
- Reusable Prefab Assets with expanded Scene Instances, path-based Overrides, Apply/Revert, and lossless Unpack
- Agent-friendly CLI for lossless project automation; Runtime physics commands use the installed Planck package

## CLI

```text
npm run ah2d -- capabilities --pretty
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- validate --file game.ah2d.json --engine
```

See [`CLI.md`](./CLI.md) for Scene, Entity, component, Prefab, runtime, physics, simulation, JSON Patch, and atomic batch workflows. The serialized contract and lifecycle rules are documented in [`../docs/PREFABS.md`](../docs/PREFABS.md).

## Unified ECS and Component Schema contract

Universal Project `format: "AH2D"`, version `4`, is the authoring source of truth. New projects also declare the independent data-model descriptor:

```js
dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 }
```

The same descriptor is included in the lossy active ECS snapshot returned by `Engine.export()`, whose document version remains `3`. Project version, data-model version, and component-schema version are separate compatibility axes. Do not save a version-3 snapshot over the version-4 Universal Project.

Every registered component exposes `authoring`, `runtime`, and `snapshot` schemas. Authoring normalization removes registered runtime-derived fields while preserving unknown JSON extensions. Runtime normalization supplies/accepts system state such as `Transform.world`; snapshot normalization retains that runtime state for an ECS export. Component values must be JSON-safe objects or arrays.

The built-in registry contains `Name`, `Transform`, `Renderable`, `Rigidbody` (`RigidBody`/`Body` aliases), `Collider`, `Hidden`, `Locked`, `PrefabInstance`, `Camera`, `Light`, `ShadowCaster`, `Animation`, `Tilemap`, `ParticleEmitter`, `BoxCollider`, `BoxCollider2D`, `CircleCollider`, and `CircleCollider2D`. It is open-world by default, so safe PascalCase custom component keys remain usable and are preserved under `components.<Type>` even without a registered specialized schema.

When a built-in component occurs in more than one authoring location, `components.<canonical-or-alias>` has precedence over legacy locations such as flat transforms, `rigidbody`/`rigidBody`, and `collider`. Resolution returns the selected `storage` and `provenance`; differing lower-precedence values are conflicts. Writes default to `storage: 'preserve'`, update the effective provenance, and leave all other locations and unknown fields untouched. Compact legacy storage is promoted to `components.<CanonicalName>` only when it cannot represent the value being written.

Register a game-specific schema before loading or creating its entities:

```js
const engine = new AH2D.Engine();

engine.registerComponent({
  type: 'Health',
  schemaVersion: 1,
  schemas: {
    authoring: {
      type: 'object',
      required: ['current', 'maximum'],
      properties: {
        current: { type: 'number', minimum: 0 },
        maximum: { type: 'number', exclusiveMinimum: 0 }
      },
      additionalProperties: true
    }
  },
  defaults: { current: 100, maximum: 100 }
});
```

Missing `runtime` or `snapshot` schemas fall back to the authoring schema. A definition may also provide aliases, per-profile schemas, `runtimeOnlyFields`, a normalizer, ordered `migrations`, and storage metadata. Registration rejects unsafe names and name/alias collisions. Pass a prepared `ComponentSchemaRegistry` as `new AH2D.Engine({ componentSchemas: registry })` when registry policy, such as `openWorld: false`, must be shared explicitly.

## Scene Graph and transform spaces

Each runtime Entity is a Scene Graph node. Universal authoring data stores its optional `parentId` and a local `Transform` (`x`, `y`, `rotation`, `scaleX`, and `scaleY`). Roots use world space as their local space. `Transform.world` is a derived Canvas-style matrix `[a,b,c,d,e,f]`; the Transform system updates a dirty Entity and its descendants in root-to-leaf order.

```js
engine.createEntity({ id: 'body', x: 100, y: 80 });
engine.createEntity({ id: 'hand', parentId: 'body', x: 24, y: 0 });
engine.createEntity({ id: 'sword', parentId: 'hand', x: 12, y: 0 });

engine.graph.traverse('body', (id, context) => {
  console.log(id, context.depth, context.path);
});

engine.reparent('sword', 'body', { preserveWorld: true });
engine.graph.detach('sword', { preserveWorld: true });

engine.transform.setLocal('sword', { rotation: 25 });
engine.transform.setWorld('sword', { x: 400, y: 220 });
const matrix = engine.transform.getWorldMatrix('sword');
const screenPoint = engine.transform.localToWorld('sword', { x: 10, y: 0 });
```

`graph.attach`, `graph.reparent`, and `graph.detach` preserve the local Transform by default. Pass `{ preserveWorld: true }` to derive a new local TRS from the previous world matrix. The operation validates before mutation: cycles, missing nodes, singular parent matrices (`E_NON_INVERTIBLE_TRANSFORM`), and local shear that cannot be represented by TRS (`E_TRANSFORM_SHEAR`) are rejected atomically.

Hierarchy queries are `roots`, `getParent`, `getChildren`, `ancestors`/`getAncestors`, `descendants`/`getDescendants`, `isAncestor`, `isDescendant`, and iterative `traverse` with pre/post order. Use `engine.destroyEntity(id, options)`, not low-level `ecs.destroy`, when hierarchy cleanup is required. Its `childPolicy` is one of:

- `reject` (default): fail if direct children exist.
- `cascade`: delete the complete subtree in post-order.
- `reparent`: move direct children to the removed node's parent.
- `detach`/`root`: make direct children roots.

`reparent`, `detach`, and `root` deletion policies also accept `preserveWorld: true`.

The Transform API exposes `getLocal`, `getLocalMatrix`, `getWorldTransform`, `getWorldMatrix`, `setLocal`, `setWorld`, `localToWorld`, and `worldToLocal`. `AH2D.Matrix2D` exposes the pure compose/multiply/invert/decompose/transformPoint helpers. A world matrix can contain shear after nested rotated non-uniform scales, so renderers should treat `getWorldMatrix`/`Transform.world` as authoritative.
Physics translation for a dynamic child under a non-uniformly scaled or reflected parent remains matrix-safe. Angular motion is rejected with `E_TRANSFORM_SHEAR` when converting the new world pose back to local TRS would require shear; the Engine never stores an approximation. Prefer an unscaled/unreflected parent or a root node for freely rotating physics-driven bodies.


## Multi-Scene projects

Universal project JSON stores every Scene independently and keeps a legacy `scene` copy of the active Scene for older runtimes:

```js
const project = {
  format: 'AH2D',
  version: 4,
  currentSceneId: 'main',
  scenes: [
    { id: 'main', name: 'Main Scene', objects: [] },
    { id: 'boss', name: 'Boss Arena', objects: [] }
  ]
};

engine.load(project);       // Loads currentSceneId.
engine.loadScene('boss');   // Switches without runtime-specific data.
```

## Prefab lifecycle

Top-level `prefabs[]` stores reusable definitions. Scene Instances stay expanded as ordinary Entity subtrees; every member maps to a stable source Entity through `components.PrefabInstance`. This keeps rendering, Physics and Scene Graph behavior independent from a particular editor or runtime adapter.

```js
const asset = engine.prefabs.createAsset('crate', { id: 'crate-prefab', name: 'Crate' });
const instance = engine.prefabs.instantiate(asset.id, {
  rootId: 'crate-2',
  parentId: 'props',
  transform: { x: 480, y: 240 }
});

engine.prefabs.setOverride('crate-2', '/color', '#ff8844');
engine.prefabs.revert('crate-2', '/color');
engine.prefabs.setOverride('crate-2', '/color', '#22cc88');
engine.prefabs.apply('crate-2', { paths: ['/color'] });
engine.prefabs.unpack(instance.instanceRootId);
```

The instance root Transform and external parent are placement, not Overrides. Identity, hierarchy, the legacy `prefab` projection and the `PrefabInstance` marker are protected paths. Structural Overrides and nested Prefab Assets are not supported; Unpack before changing the connected hierarchy. Asset deletion rejects connected Instances unless `deleteAsset(id, { unpackInstances: true })` is explicit.

## Runtime selection and preview lifecycle

```js
const engine = new AH2D.Engine({ runtime: 'pixijs' });

engine.useRuntime('phaserjs', { Phaser: window.Phaser });
engine.start(previewElement, { restoreOnStop: true });
engine.pause();
engine.resume();
engine.stop(); // Restores the pre-play snapshot when restoreOnStop is true.

engine.useRuntime('custom', {
  mount(engine, target) {},
  render(engine, alpha) {},
  destroy() {}
});
```

`runtime.name` is the requested runtime and `runtime.backend` identifies the active implementation (`pixijs`, `phaserjs`, `custom`, or `editor-bridge`).

## Rigidbody and Collider schema

```js
{
  rigidbody: {
    enabled: true,
    type: 'dynamic', // dynamic | kinematic | static
    mass: 1,
    useAutoMass: false,
    gravityScale: 1,
    linearDamping: 0.08,
    angularDamping: 0.08,
    velocityX: 0,
    velocityY: 0,
    angularVelocity: 0, // degrees per second
    fixedRotation: false,
    bullet: false,
    allowSleep: true,
    sleeping: false
  },
  collider: {
    enabled: true,
    shape: 'rectangle', // rectangle | box | circle
    width: 64,
    height: 64,
    radius: 32,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    density: 1,
    friction: 0.35,
    restitution: 0.05,
    isTrigger: false,
    categoryBits: 1,
    maskBits: 65535,
    groupIndex: 0
  }
}
```

`Collider` also accepts an array or `{ colliders: [...] }` / `{ shapes: [...] }`; every enabled entry creates one native fixture. Explicit fixture IDs must be unique per Entity; stable IDs make contact payloads and `getNativeFixture()` deterministic.

Collider-only entities are static. The physics API also exposes `applyForce`, `applyTorque`, `applyImpulse`, `setVelocity`, `setAngularVelocity`, `setTransform`, `setGravity`, `setPixelsPerMeter`, `wake`, `sleep`, `snapshot`, and `restore`.

Collision events are emitted as `physics:collisionstart`, `physics:collisionstay`, and `physics:collisionend`. Trigger events use `physics:triggerenter`, `physics:triggerstay`, and `physics:triggerexit`.

Normal execution reports `backend: "box2d"`, `implementation: "planck"`, and `native: true`. The built-in solver reports `backend: "builtin"`, `implementation: "ah2d-builtin"`, and `native: false`; request it through Universal Project `engine.physics` or lock it for a host with `{ physics: "builtin" }`. Native Planck handles are exposed by `getNativeWorld()`, `getNativeBody(entityId)`, and `getNativeFixture(entityId, colliderId)` for Runtime-only extensions.

See [`../docs/PHYSICS.md`](../docs/PHYSICS.md) for units, multi-fixture layouts, stepping, contact payloads, CLI selection, Play Mode, lifecycle, and native-extension boundaries.

The universal AH2D JSON remains the source of truth, so scenes and physics components are portable across all runtime adapters.

## Verification

```text
node engine/AH2DEngine.test.js
```

The suite covers deep nested local/world transforms, dirty propagation, traversal, cycle protection, preserve-world reparent/detach, atomic singular/shear rejection, graph-aware deletion, runtime selection, gravity and damping, native contacts, triggers, collision filters, automatic mass, forces, torque, impulses, kinematic bodies, sleeping, bounded substeps, native-handle access, lifecycle restoration, native Box2D conversion, and the Editor contract.
