# Shader Graph and Post Process

AH2D stores node-based post-process shaders as framework-neutral authoring data. The graph is portable project data; a renderer adapter decides how to execute the compiled graph. PixiJS has a native filter path, while PhaserJS and custom hosts can consume the same compiled descriptor or implement their own mapping.

## Universal Project contract

Shader graphs live in the top-level `shaderGraphs` array. A Post Process effect references a graph by its stable `id`:

```json
{
  "shaderGraphs": [
    {
      "id": "cinematic-grade",
      "name": "Cinematic Grade",
      "version": 1,
      "domain": "postProcess",
      "nodes": [
        {
          "id": "source",
          "type": "sceneTexture",
          "position": { "x": 40, "y": 120 },
          "parameters": {}
        },
        {
          "id": "grade",
          "type": "saturation",
          "position": { "x": 300, "y": 120 },
          "parameters": { "amount": 1.15 }
        },
        {
          "id": "output",
          "type": "output",
          "position": { "x": 560, "y": 120 },
          "parameters": {}
        }
      ],
      "links": [
        {
          "id": "source-grade",
          "from": { "nodeId": "source", "port": "color" },
          "to": { "nodeId": "grade", "port": "color" }
        },
        {
          "id": "grade-output",
          "from": { "nodeId": "grade", "port": "color" },
          "to": { "nodeId": "output", "port": "color" }
        }
      ],
      "outputNodeId": "output"
    }
  ],
  "postProcess": {
    "enabled": true,
    "effects": [
      {
        "id": "cinematic-grade-effect",
        "type": "shaderGraph",
        "graphId": "cinematic-grade",
        "name": "Cinematic Grade",
        "enabled": true,
        "parameters": {}
      }
    ]
  }
}
```

Graph, Node, Link, and Effect IDs are authoring identity. Rename display labels without changing those IDs. Node coordinates are Editor layout data and do not affect rendering. Preserve unknown graph, node, link, endpoint, effect, and parameter fields during round trips.

Only `domain: "postProcess"` and graph `version: 1` are currently accepted. Unsupported domains/versions are validation errors. Unknown node types and extension fields are preserved by compatibility round trips, but unknown nodes produce a warning in compatibility mode and an error in strict validation; the Runtime compiler never silently treats them as a valid filter.

## Built-in nodes

All current ports carry a straight/unassociated RGBA `color` value. `ShaderGraphSystem.evaluate()` uses the same representation, including RGB values whose alpha is zero. The PixiJS adapter converts its premultiplied Scene texture samples to straight RGBA at `sceneTexture`, keeps every intermediate Node straight, and premultiplies exactly once at `output`.

| Node | Inputs | Outputs | Parameters and defaults |
| --- | --- | --- | --- |
| `sceneTexture` | — | `color` | — |
| `output` | `color` | — | — |
| `tint` | `color` | `color` | `color: "#ffffff"`, `amount: 1` |
| `grayscale` | `color` | `color` | `amount: 1` |
| `brightnessContrast` | `color` | `color` | `brightness: 0`, `contrast: 1` |
| `saturation` | `color` | `color` | `amount: 1` |
| `invert` | `color` | `color` | `amount: 1` |
| `vignette` | `color` | `color` | `intensity: 0.35`, `softness: 0.5`, `radius: 0.75` |
| `pixelate` | `color` | `color` | `size: 4` |
| `chromaticAberration` | `color` | `color` | `amount: 2` |
| `mix` | `a`, `b` | `color` | `factor: 0.5` |

The `tint.color` contract accepts hexadecimal `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA` strings (case-insensitive), matching Runtime parsing; the optional alpha is the final component. Other strings are validation errors instead of silently rendering as white. The DataModel normalizer fills missing known parameters and preserves custom parameters. Validation enforces the documented parameter ranges; Runtime evaluation safely bounds values where the image operation requires it.

## Editor workflow

Open the **Shaders** workspace from the top navigation. The workspace provides:

- a graph library with create, duplicate, select, rename, and delete;
- a node palette, draggable nodes, typed ports, live Bezier links, and disconnect;
- Shift selection, box selection, multi-node movement, Delete, pan, wheel zoom, and Fit;
- an Inspector for the selected node's parameters and live CPU preview;
- compiler status and diagnostics;
- a project Post Process stack with master enable, per-effect enable, ordering, removal, and graph-effect creation.

Adding a graph to the Post Process stack creates an effect that references `graphId`; it does not copy the graph. Editing the graph therefore updates every referencing effect. Deleting a graph also removes its dangling Editor-created effects. Undo/Redo and Save/Load operate on the complete graph library and stack.

The CPU preview is the framework-neutral reference for the supported nodes. It is deterministic and useful for authoring, tests, and custom integrations; renderer output can differ slightly because of texture sampling and color-space details.

## Runtime API

Load the Universal document before compiling or resolving Post Process effects:

```js
const engine = new AH2D.Engine({ runtime: 'pixijs' });
engine.load(project);

console.log(engine.shaders.list());
console.log(engine.shaders.get('cinematic-grade'));

const compiled = engine.shaders.compile('cinematic-grade');
const diagnostics = engine.shaders.getDiagnostics('cinematic-grade');

engine.shaders.setNodeParameters('cinematic-grade', 'grade', {
  amount: 1.25
});

engine.postProcess.configure('cinematic-grade-effect', {
  enabled: true,
  parameters: { grade: { amount: 0.8 } }
});

console.log(engine.postProcess.resolvedActive);
```

`engine.shaderGraphs` is an alias of `engine.shaders`. `engine.shaders.toJSON()` exports the normalized authoring graphs, not a Runtime-only snapshot. Changes emit `shadergraph:change`; compilation emits `shadergraph:compile`, and rejected compilation emits `shadergraph:error` with diagnostics.

`compile(idOrGraph, options)` returns `{ valid, graphId, diagnostics, order, vertexSource, fragmentSource, shaderKey, uniforms }`. Set `options.parameters` for non-destructive per-effect overrides and `throwOnError: true` when invalid authoring must raise `ShaderGraphCompileError`. For deterministic CPU evaluation, call:

```js
const result = engine.shaders.evaluate(
  'cinematic-grade',
  { color: [0.4, 0.7, 1, 1], uv: [0.5, 0.5], resolution: [1280, 720] },
  { parameters: {} }
);
console.log(result.valid, result.color, result.diagnostics);
```

The input may also be an RGBA array. A custom `sample(uv)` function lets screen-space nodes sample a deterministic source in tests. `setNodeParameters(graphId, nodeId, values, { replace })` mutates authoring data; `configure` is its alias.

Compilation is graph-aware: it resolves the declared Output, validates ports and links, rejects cycles in the Output-reachable chain, and rejects ambiguous input wiring. Disconnected nodes—including incomplete experimental branches—remain valid authoring data until they are wired into Output. A failed compile never masquerades as a valid pass-through filter.

### PixiJS

The PixiJS adapter converts active built-in effects and compiled `shaderGraph` effects into reusable Pixi filters attached to a stable, identity-transformed viewport root that contains the camera-transformed world. Its explicit filter area tracks the full renderer size, so Camera movement/zoom cannot shrink or shift Post Process coverage and resize does not rebuild unchanged filters. It synchronizes graph parameters/uniforms after changes and removes stale filters when an effect is disabled or removed. Built-in Bloom keeps both RGB and alpha premultiplied, allowing later straight-RGB passes to unpremultiply safely. Generated AH2D filters currently target PixiJS WebGL; when the active Pixi renderer is WebGPU or Canvas, the adapter skips those effects, emits `runtime:postProcessError` and `runtime:postProcessFallback` with `fallback: "effect-skipped"`, and keeps the scene running. A missing or invalid individual effect uses the same isolated fallback, so other valid effects continue rendering. The adapter does not use `unsafe-eval`.

```js
const engine = new AH2D.Engine({ runtime: 'pixijs' });
engine.load(project);
engine.start(document.querySelector('#game'));
```

### PhaserJS and custom renderers

Framework independence means the project contract does not contain Phaser pipelines or host objects. These adapters can consume `engine.postProcess.resolvedActive` and map each compiled descriptor to their native shader/filter API:

```js
engine.events.on('postprocess:change', () => {
  host.applyPostProcess(engine.postProcess.resolvedActive);
});
```

Do not persist textures, GPU handles, compiled programs, filter instances, functions, or DOM values in `shaderGraphs` or `postProcess`. Keep them in Runtime-side maps keyed by stable graph/effect IDs.

## CLI and agent-safe edits

Discover the contract instead of parsing human help:

```powershell
npm run ah2d -- capabilities --pretty
npm run ah2d -- schema show --name shaderGraph --pretty
npm run ah2d -- schema show --name postProcess --pretty
npm run ah2d -- schema show --name postProcessEffect --pretty
npm run ah2d -- resource list --file game.ah2d.json shader --pretty
npm run ah2d -- resource get --file game.ah2d.json shader cinematic-grade --pretty
```

The resource aliases `shader`, `shaders`, `shaderGraph`, and `shaderGraphs` all address the top-level graph library. Use the standard SHA-256 precondition for mutation:

```powershell
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- resource put --file game.ah2d.json shader --value @cinematic-grade.shader.json --dry-run --include-document --pretty
npm run ah2d -- resource put --file game.ah2d.json shader --value @cinematic-grade.shader.json --write --expect-sha256 <sha256>
npm run ah2d -- validate --file game.ah2d.json --engine --strict --pretty
```

Delete uses the same explicit mutation mode:

```powershell
npm run ah2d -- resource delete --file game.ah2d.json shader cinematic-grade --dry-run --pretty
npm run ah2d -- resource delete --file game.ah2d.json shader cinematic-grade --write --expect-sha256 <sha256>
```

For a Studio-managed project, update `shaderGraphs` and the referencing `postProcess.effects` through `/api/projects/:projectId/document` with the latest numeric `expectedRevision` and one idempotent `clientMutationId`. Do not edit `.ah2d-data/collaboration` directly and do not substitute the CLI SHA-256 for a Studio revision.

## Validation checklist

- When present, `postProcess` is an object with an `effects` array; `enabled` is an optional boolean.
- Every Effect has a non-empty stable `id`, a non-empty string `type`, and an ID unique within the Post Process stack.
- Optional Effect `graphId` values are non-empty stable IDs, `parameters` is a plain object, and custom extension fields remain allowed.
- Every Graph, Node, and Link ID is non-empty and unique in its scope.
- `outputNodeId` identifies an `output` Node.
- Every Link endpoint names an existing Node and a declared port in the correct direction.
- An input has at most one incoming Link.
- The reachable graph is acyclic and has a path from `sceneTexture` to `output`.
- Every `shaderGraph` effect references an existing graph.
- All persisted values are finite and JSON-safe.
- Unknown extensions remain unchanged after Editor, CLI, and Studio round trips.
- PixiJS visual behavior is tested separately from contract validation.
