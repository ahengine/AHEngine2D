# Particle Assets and Curves

AH2D stores reusable particle definitions in the Universal Project's top-level
`particles[]` library. A Scene or Prefab Entity does not copy the effect. It
binds a `ParticleEmitter` component to the Particle Asset's stable `id`.
Simulation state is Runtime-only and must never be used as authoring truth.

## Canonical Particle Asset v1

```json
{
  "id": "magic-sparkle",
  "name": "Magic Sparkle",
  "duration": 1.5,
  "loop": true,
  "maxParticles": 256,
  "emission": { "rate": 80, "burst": 12 },
  "lifetime": { "min": 0.4, "max": 1.2 },
  "velocity": {
    "speedMin": 50,
    "speedMax": 110,
    "angle": -90,
    "spread": 70,
    "gravityX": 0,
    "gravityY": 45
  },
  "shape": { "type": "circle", "radius": 20, "width": 0, "height": 0 },
  "appearance": {
    "assetId": "spark-texture",
    "color": "#80bfff",
    "blend": "additive",
    "baseScale": 1,
    "baseOpacity": 1,
    "baseHue": 0
  },
  "curves": [
    {
      "id": "opacity-over-life",
      "property": "opacity",
      "interpolation": "cubic",
      "keys": [
        { "id": "fade-in", "time": 0, "value": 0, "outTangent": 5 },
        { "id": "opaque", "time": 0.2, "value": 1, "inTangent": 0, "outTangent": 0 },
        { "id": "fade-out", "time": 1, "value": 0, "inTangent": -2 }
      ]
    }
  ]
}
```

`duration` is the emitter cycle duration. `lifetime` is sampled independently
for each particle. `angle` and `spread` are degrees. `shape.type` is `point`,
`circle`, or `box`; the relevant radius or width/height controls the spawn
area. `appearance.assetId` may reference an image in top-level `assets[]`.
Without a texture, the PixiJS adapter renders a small graphics particle.

Every Asset, Curve, and key has a stable, non-empty ID. Unknown JSON-safe
fields are preserved by normalization and lossless CLI resource writes.

## Curve semantics

Curve key times are normalized to `0..1`. Keys are sorted by ascending time
and one Asset may contain at most one Curve for each property:

| Property | Time source | Value meaning |
| --- | --- | --- |
| `emission` | normalized emitter-cycle time | multiplier for `emission.rate` |
| `scale` | normalized particle age | multiplier for `appearance.baseScale` |
| `speed` | normalized particle age | multiplier for the initial velocity; gravity remains additive |
| `opacity` | normalized particle age | multiplier for `appearance.baseOpacity`, clamped to `0..1` |
| `hue` | normalized particle age | degree offset added to `appearance.baseHue` |

Interpolation is `linear`, `step`, or `cubic`. Cubic uses Hermite tangents in
value-per-normalized-time units: the outgoing tangent belongs to the left key
and the incoming tangent belongs to the right key. Missing cubic tangents use
the segment slope, so a cubic Curve without explicit tangents stays linear.

The shared non-mutating sampler is available to tools and custom hosts:

```js
const value = AH2DDataModel.sampleParticleCurve(curve, normalizedTime, {
  defaultValue: 1
});
```

The Editor Curve panel edits these actual key records. Adding, dragging,
deleting, changing interpolation, and Undo/Redo all update the selected
Particle Asset; the preview reads the same data rather than drawing decorative
curves.

## ParticleEmitter binding

```json
{
  "components": {
    "ParticleEmitter": {
      "assetId": "magic-sparkle",
      "autoplay": true,
      "playing": true,
      "loop": true,
      "time": 0,
      "speed": 1,
      "emitting": true,
      "seed": 42,
      "overrides": {
        "emission": { "rate": 120 }
      }
    }
  }
}
```

`overrides` is deep-merged over the resolved Asset, but cannot replace its
identity. Use it for per-instance tuning; edit the Particle Asset when every
instance should change. The optional integer `seed` makes one emitter's random
sequence reproducible.

Legacy inline `ParticleEmitter` fields remain readable in compatibility mode
and are preserved losslessly. They produce a migration warning, and strict
validation requires a real `assetId`. The Runtime can simulate such an emitter
through an unregistered compatibility Asset synthesized in memory; an explicit
but unresolved `assetId` never falls back to inline values. In this legacy form,
`speed` remains particle velocity and optional `timeScale` controls playback.
Legacy flat top-level Particle records are normalized explicitly into v1
Assets; read-only operations do not silently rewrite them.

Authoring serialization removes these Runtime-only fields:

- `particles`
- `emissionAccumulator`
- `completed`
- `rngState`

## Runtime API

The framework-neutral system is available as `engine.particles`:

```js
engine.load(project);

engine.particles.play("spark-emitter");
engine.particles.pause("spark-emitter");
engine.particles.restart("spark-emitter", { clear: true });
engine.particles.stop("spark-emitter", { clear: true, reset: true });

const authoredAsset = engine.particles.getAsset("magic-sparkle");
const effectiveAsset = engine.particles.effectiveAsset("spark-emitter");
const runtimeState = engine.particles.getState("spark-emitter");
```

`engine.update(dt)` advances ParticleSystem after animation, transforms, and
physics. The system uses a deterministic fixed step (default `1/120` second),
an independent LCG stream per emitter, exact burst/cycle handling, a capacity
limit, and deterministic point/circle/box spawning. Snapshot/restore is wired
into Engine Play Mode, so stopping Play restores the authored state and live
particles do not leak into the project.

Listen for lifecycle events when gameplay or audio must react:

```js
engine.events.on("particle:burst", ({ entityId, count }) => {
  console.log(entityId, count);
});

engine.events.on("particle:complete", ({ entityId }) => {
  engine.destroyEntity(entityId, { childPolicy: "cascade" });
});
```

Available events are `particle:play`, `particle:pause`, `particle:stop`,
`particle:restart`, `particle:emit`, `particle:burst`, `particle:death`,
`particle:complete`, `particle:update`, `particle:restore`, and
`particle:assetMissing`.

PixiJS renders both texture-backed and graphics particles, including Transform
inheritance, position, rotation, scale, opacity, hue, and normal/additive blend
modes. Particle visuals and owned cropped textures are released when a
particle or emitter disappears. PhaserJS and Custom hosts consume the same
runtime state from `ParticleEmitter.particles` and remain responsible for
creating their native visuals.

## CLI and validation

Discover the machine-readable contract before editing:

```text
npm run ah2d -- capabilities --pretty
npm run ah2d -- schema show --name particleAsset --pretty
npm run ah2d -- schema show --component ParticleEmitter --pretty
```

Particle Assets use the ordinary lossless resource commands:

```text
npm run ah2d -- resource list particle --file game.ah2d.json --pretty
npm run ah2d -- resource get particle --id magic-sparkle --file game.ah2d.json --pretty
npm run ah2d -- resource put particle --value @particle.json --file game.ah2d.json --dry-run --pretty
npm run ah2d -- resource put particle --value @particle.json --file game.ah2d.json --write --expect-sha256 <hash>
npm run ah2d -- validate --file game.ah2d.json --strict --engine --pretty
```

Deleting an Asset referenced by a Scene or Prefab is rejected. For several
related changes, update the Asset and its emitter bindings in one atomic
`apply` operation. Do not hand-edit Studio-managed collaboration documents.

Standalone export uses `format: "AH2D.Particle"`, `version: 1`, followed by the
canonical Asset fields. It is an Asset exchange format, not a Universal
Project and therefore is not accepted by Project Load directly.
