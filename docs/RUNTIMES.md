# Universal Runtime adapters

AH2D loads one Universal Project version 4 document and builds one live ECS and Scene Graph. `pixijs`, `phaserjs`, and `custom` are renderer choices over that same state; they are not import/export formats and do not create runtime-specific copies of the project.

```js
const engine = new AH2D.Engine();
engine.load(project, { sceneId: 'main' });
engine.useRuntime('phaserjs', { Phaser }); // or pixijs / custom
engine.start(document.querySelector('#game'), { paused: true });
await engine.runtime.ready;
if (!engine.runtime.native) throw engine.runtime.error;
engine.resume();
```

The selected value can be persisted as `engine.runtime`, but renderer objects, textures, canvases, Phaser Game Objects, and GPU handles are Runtime-only. Never write them into the Universal JSON. `Engine.export()` is a lossy active ECS snapshot and must not be used to replace the authoring document.

## Shared lifecycle

AH2D owns the simulation clock. The Engine frame runs Animation, transforms, Skeleton/IK, Physics, particles, final transforms, and then exactly one adapter synchronization. A Phaser Scene or custom host must not call `engine.update()` from a second loop.

All built-in adapters expose:

- `runtime.name`: requested adapter (`pixijs`, `phaserjs`, or `custom`)
- `runtime.backend`: active native backend or `editor-bridge`
- `runtime.native`: whether native mounting succeeded
- `runtime.ready`: mount/asset initialization promise
- `runtime.objects`: Runtime-only Entity-to-display record map
- `render()`, `resize()`, `unmount()`, and `destroy()`

`engine.pause()` keeps the mounted display tree. `engine.resume()` continues it. `engine.stop()` unmounts the renderer and, by default, restores the complete pre-Play snapshot.

Use `engine.start(target, { paused: true })` when initialization is asynchronous. It mounts the adapter without advancing Animation, Physics, particles, or the AH2D frame clock. Await `runtime.ready`, verify `runtime.native`/`runtime.backend`, then call `resume()`. Cancelling with `stop()` settles a pending readiness promise for both Phaser and Custom hosts; a late host callback cannot remount a stopped generation.

## PhaserJS

For a plain Browser page, load Phaser before `AH2DEngine.js`:

```html
<script src="./node_modules/phaser/dist/phaser.min.js"></script>
<script src="./engine/AH2DDataModel.js"></script>
<script src="./engine/AH2DEngine.js"></script>
```

The managed path creates and owns a `Phaser.Game`:

```js
engine.useRuntime('phaserjs', {
  Phaser,
  designWidth: 1920,
  designHeight: 1080,
  fit: 'contain',
  transparent: true,
  textureResolver(renderable, entityId, engine, Phaser, adapter) {
    return assetUrls.get(renderable.assetId) || renderable.imageSrc || null;
  },
  gameConfig: {
    render: { antialias: true }
  }
});

engine.start(document.querySelector('#game'), { paused: true });
await engine.runtime.ready;
if (!engine.runtime.native) throw engine.runtime.error;
engine.resume();
```

The managed adapter defaults to Phaser WebGL, `loader.imageLoadType: "HTMLImageElement"`, and Scale Manager `RESIZE`. WebGL is required because Phaser Canvas does not implement the tint used by Universal `Renderable.color` and particle hue; an explicitly forced or injected Canvas renderer fails with `E_RUNTIME_CAPABILITY` instead of drawing a misleading result. Use the `custom` adapter when Canvas2D is required. AH2D applies the Universal Camera and `fit` policy once in game coordinates. A project can still override `gameConfig.scale` or `scale`, but must not also apply a second Camera/viewport transform.

An existing game host can inject a Scene. AH2D creates only its own display subtree and never destroys the host Scene/Game:

```js
engine.useRuntime('phaserjs', {
  Phaser,
  scene: gameplayScene,
  sync(scene, engine, adapter) {
    // Optional Runtime-only integration after the built-in ECS sync.
  },
  postProcess(scene, resolvedActive, engine) {
    applyProjectPipelines(scene, resolvedActive);
  }
});
```

By default an injected host Scene receives a dedicated identity Phaser Camera. Existing host Cameras ignore the AH2D subtree and the dedicated Camera ignores existing host objects, preventing host scroll/zoom or extra Cameras from applying the Universal Camera twice. Set `isolateCamera: false` only when the host deliberately owns this filtering and camera composition.

An injected `scene`, or an existing Scene selected by `game` plus `sceneKey`, must already be active. Start or wake it in the host before mounting AH2D. If an explicit key does not exist, the adapter creates and owns that integration Scene; it never substitutes an unrelated active Scene. AH2D never starts, wakes, stops, removes, or destroys a host-owned Scene.

The adapter mirrors every Entity as a nested Phaser Container, applies local Transform state, and reconciles create/delete/reparent operations each Frame. It maps Renderable to Image or Rectangle, including anchor, size, tint, opacity, visibility, sibling layer order, blend mode, `imageSrc`/Asset lookup, and a size/origin-correct `sourceRect` crop. It creates correctly sized Runtime Game Objects for deterministic `ParticleEmitter.particles`, applies the active Camera as a viewport transform, and draws a framework-neutral Skin triangle fallback from `Skin.deformedVertices`.

`textureResolver` is synchronous and may return a source string, `{ source, key }`, or an already-loaded texture key. It receives `(renderable, entityId, engine, Phaser, adapter)`. `transparent: true` takes precedence over `Camera.clearColor`; otherwise the active Camera color is used. A Camera hierarchy whose inverse produces shear cannot be represented by a Phaser Container and fails closed with `E_TRANSFORM_SHEAR` instead of approximating the view.

`Renderable.frame` is passed to Phaser only when the host texture exposes matching frame metadata. A frame number alone cannot identify sprite-sheet coordinates; author `sourceRect` or preload a framed Phaser texture.

Phaser Post Process APIs are deliberately host-extensible because native pipelines/filters are renderer-version-specific. The ordered, normalized descriptors are passed to the `postProcess` callback through `engine.postProcess.resolvedActive`; no Phaser object is persisted in the project.

## Custom Canvas2D

With no renderer hooks, `custom` is a native Canvas2D adapter:

```js
engine.useRuntime('custom', {
  designWidth: 1920,
  designHeight: 1080,
  fit: 'contain',
  clearColor: '#101826',
  imageResolver(renderable, entityId, engine) {
    return renderable.assetId ? imageCache.get(renderable.assetId) : null;
  },
  postProcess(context, canvas, resolvedActive, engine) {
    applyCanvasEffects(context, canvas, resolvedActive);
  }
});

engine.start(document.querySelector('#game'), { paused: true });
await engine.runtime.ready;
engine.resume();
```

The adapter accepts a Canvas target, an element that can own a generated Canvas, `options.canvas`, or `options.canvasFactory`. It composes device-pixel ratio, active Camera, and exact `Transform.world` matrices, so nested rotation/non-uniform scale remains correct. It renders image or color Renderables, tint/hue, nine-argument `drawImage` crops for `sourceRect`, visibility inheritance, layer-stable hierarchy order, Skin triangles, and live particles. Missing authored image dimensions use a stable `64x64` fallback rather than the image's changing natural size. `imageResolver` runs even for an Asset reference that has no URL, allowing a host-owned/preloaded image cache to satisfy the same Universal `assetId`. Shared images stay in a Runtime cache. Calling `resize(width, height)` updates the backing Canvas immediately, including while Play is paused.

The original host-renderer contract remains available. Supplying `render(engine, alpha)` selects exclusive host mode, so AH2D does not create a second Canvas:

```js
engine.useRuntime('custom', {
  mount(engine, target) { renderer.attach(target); },
  render(engine, alpha) {
    renderer.draw(engine.ecs, engine.graph, engine.camera.view, alpha);
  },
  unmount() { renderer.detach(); },
  destroy() { renderer.dispose(); }
});
```

Optional `afterRender(context, canvas, engine, alpha, adapter)` and `postProcess(context, canvas, resolvedActive, engine, adapter)` hooks extend the built-in Canvas path. Renderer failures emit the standard `runtime:fallback`, `runtime:error`, or `runtime:textureError` events.

## Local project assets in Studio

Universal JSON keeps portable relative paths such as `textures/hero.png`. When Studio opens the containing folder, it resolves only project-root-safe image paths, reads the matching files, and sends ephemeral `data:image/...;base64` sources to the sandboxed Editor. Asset IDs and normalized paths point to the same in-memory source, so PixiJS, PhaserJS, Custom Canvas2D, Scene preview, Animator, and Particle preview all resolve the same asset. These data URLs never replace authored paths and are never saved. Opening only a standalone JSON file cannot grant sibling-file access; open the project folder to resolve relative assets.

## Current renderer boundaries

- Transform, Renderable, Hidden, hierarchy, Camera, particles, animation output, and basic Skin deformation are synchronized by Phaser and Custom adapters.
- Box2D/Planck remains the physics authority for every renderer; Phaser Arcade/Matter bodies are not serialized or simulated in parallel.
- Light, Shadow, and Tilemap components remain portable data and require host-specific drawing until their native adapter mappings are implemented.
- PixiJS owns its native WebGL Post Process filters. Phaser and Custom receive the same ordered `resolvedActive` descriptors through hooks.
- Unknown project fields and custom ECS components remain untouched by every renderer.

## Validation

```powershell
npm run ah2d -- validate --file game.ah2d.json --engine --pretty
npm run test:engine
npm run check
```

Switching the runtime must not change the document hash except when the user intentionally persists `engine.runtime` as a project setting.
