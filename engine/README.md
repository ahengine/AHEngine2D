# AH2D Engine

For the complete Universal Editor output contract and game-programming examples, see [`../README.md`](../README.md). For the coding-Agent workflow, see [`../Agent.md`](../Agent.md).

AH2D keeps editor data independent from a specific renderer. The editor can preview the same universal scene through the `pixijs`, `phaserjs`, or `custom` runtime adapter. If PixiJS or Phaser is not loaded, the selected adapter runs through the editor Canvas compatibility bridge and reports that backend explicitly.

## Stack

- Scene Graph with cycle-safe nested parent/child relationships
- Entity Component System (ECS)
- Transform, Camera, Lighting, Shadow, Animation, and Tilemap systems
- Box2D adapter with pixel/metre conversion
- Deterministic built-in 2D physics fallback for offline editor previews
- Runtime adapters for PixiJS, PhaserJS, and custom hosts
- Editor bridge for `AH2DEdtior.html`
- Multi-Scene project loading and runtime Scene switching
- Dependency-free, agent-friendly CLI for lossless project automation

## CLI

```text
npm run ah2d -- capabilities --pretty
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- validate --file game.ah2d.json --engine
```

See [`CLI.md`](./CLI.md) for Scene, Entity, component, runtime, physics, simulation, JSON Patch, and atomic batch workflows.

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

Collider-only entities are static. The physics API also exposes `applyForce`, `applyTorque`, `applyImpulse`, `setVelocity`, `setAngularVelocity`, `setTransform`, `wake`, `sleep`, `snapshot`, and `restore`.

Collision events are emitted as `physics:collisionstart`, `physics:collisionstay`, and `physics:collisionend`. Trigger events use `physics:triggerenter`, `physics:triggerstay`, and `physics:triggerexit`.

The universal AH2D JSON remains the source of truth, so scenes and physics components are portable across all runtime adapters.

## Verification

```text
node engine/AH2DEngine.test.js
```

The suite covers transform/scene graph sync, runtime selection, gravity and damping, circle/rotated-box contacts, wide-ground box stability, triggers, collision filters, automatic mass, impulses, kinematic bodies, sleeping, pause/resume/stop restoration, native Box2D unit conversion, and the editor integration contract.
