'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'AH2DEdtior.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(Boolean);

for (const [index, source] of scripts.entries()) {
  assert.doesNotThrow(
    () => new vm.Script(source, { filename: `AH2DEdtior.inline-${index + 1}.js` }),
    `inline script ${index + 1} must parse`
  );
}

const DataModel = require('./engine/AH2DDataModel.js');
const NODE_TYPES = [
  'sceneTexture', 'output', 'tint', 'grayscale', 'brightnessContrast', 'saturation',
  'invert', 'vignette', 'pixelate', 'chromaticAberration', 'mix'
];

assert.deepEqual([...DataModel.SHADER_NODE_TYPES], NODE_TYPES, 'Editor and DataModel must share the canonical node set');

for (const id of [
  'shaderPage', 'shaderGraphSelect', 'newShaderGraph', 'duplicateShaderGraph', 'deleteShaderGraph',
  'fitShaderGraph', 'shaderCompileStatus', 'shaderGraphViewport', 'shaderGraphSurface', 'shaderLinks',
  'shaderNodes', 'shaderPreviewCanvas', 'shaderPostStack', 'shaderEffectGraph', 'addShaderEffect',
  'shaderAddNodeType', 'addShaderNode'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `Shaders workspace must expose #${id}`);
}
assert.match(html, /class="ws" data-page="shaders"/, 'header must expose the Shaders workspace');
assert.match(html, /\.body:not\(\.left-closed\) \.shader-page\{--shader-left-gutter:/, 'Shaders must reserve the visible left overlay');
assert.match(html, /\.body:not\(\.right-closed\) \.shader-page\{--shader-right-gutter:/, 'Shaders must reserve the visible Inspector overlay');
assert.match(html, /\.shader-shell\{[^}]*left:var\(--shader-left-gutter\)[^}]*right:var\(--shader-right-gutter\)[^}]*transition:left/, 'Shader panels must animate with both overlay gutters');
assert.match(html, /@container shader-workspace \(max-width:520px\)/, 'Shader panels must collapse cleanly when both overlay gutters leave a narrow workspace');
assert.match(html, /\.shader-toolbar>\.ibtn,\.shader-toolbar>\.shader-compile\{flex:0 0 auto;white-space:nowrap\}/, 'responsive toolbar actions must stay intact rather than shrink or wrap');
assert.match(html, /@container shader-workspace \(max-width:760px\)\{[^}]*\.shader-body\{grid-template-columns:minmax\(0,1fr\);grid-template-rows:/, 'a 1280-wide Editor with both docks must stack the Shader sidecar below the graph');
assert.match(html, /@container shader-workspace \(max-width:760px\)[\s\S]*?\.shader-toolbar>b\{display:none\}/, 'the compact Shader toolbar must release its decorative heading before controls overflow');
assert.match(html, /@container shader-workspace \(max-width:760px\)[\s\S]*?\.shader-toolbar \.field\{width:128px;flex-basis:128px\}/, 'compact Shader selectors must leave every toolbar action visible without a scrollbar');
assert.match(html, /\.shader-stack-item\{[^}]*grid-template-columns:36px minmax\(0,1fr\) auto/, 'Post Process toggles must have a dedicated 36px column');
for (const type of NODE_TYPES) {
  assert.match(html, new RegExp(`data-add-shader-node=["']${type}["']`), `${type} must be available in the node palette`);
  assert.match(html, new RegExp(`(?:^|\\s)${type}:\\{label:`, 'm'), `${type} must have Editor port and parameter metadata`);
}

const defaultFactorySource = html.match(/const createDefaultShaderGraphs=\(\)=>\{[\s\S]*?\r?\n\};(?=\r?\nconst createDefaultParticles)/)?.[0];
assert.ok(defaultFactorySource, 'default Shader Graph factory must be present');
const defaultGraphs = new Function('AH2D', `${defaultFactorySource}; return createDefaultShaderGraphs();`)({ DataModel });
assert.equal(defaultGraphs.length, 1, 'a new Project must start with one useful Shader Graph');
assert.deepEqual(
  DataModel.validateShaderGraphDocument({ shaderGraphs: defaultGraphs }, { strict: true }).filter(item => item.severity === 'error'),
  [],
  'default Shader Graphs must satisfy the canonical strict contract'
);
assert.equal(defaultGraphs[0].version, 1);
assert.equal(defaultGraphs[0].domain, 'postProcess');
assert.equal(defaultGraphs[0].nodes.find(node => node.id === defaultGraphs[0].outputNodeId)?.type, 'output');
const defaultGraphHorizontalSpan = Math.max(...defaultGraphs[0].nodes.map(node => node.position.x + 190))
  - Math.min(...defaultGraphs[0].nodes.map(node => node.position.x));
assert.ok((650 - 80) / defaultGraphHorizontalSpan >= 0.65, 'the default graph must remain legible when fitted into the 1280px docked Editor layout');

global.window = global;
require('./engine/AH2DEngine.js');
const runtimeShaders = new global.AH2D.ShaderGraphSystem(null);
runtimeShaders.load({ shaderGraphs: defaultGraphs }, { emit: false });
const runtimeCompilation = runtimeShaders.compile(defaultGraphs[0].id, { emit: false });
assert.equal(runtimeCompilation.valid, true, 'the default Editor graph must compile in the real Engine');
assert.match(runtimeCompilation.vertexSource, /vTextureCoord/, 'Engine compilation must emit a vertex program');
assert.match(runtimeCompilation.fragmentSource, /finalColor/, 'Engine compilation must emit a fragment program');
assert.ok(runtimeCompilation.shaderKey, 'Engine compilation must expose a stable shader cache key');

const preserved = DataModel.normalizeShaderGraph({
  ...defaultGraphs[0],
  extension: { future: true },
  nodes: defaultGraphs[0].nodes.map((node, index) => index === 1
    ? { ...node, pluginNodeField: 'keep', parameters: { ...node.parameters, customUniform: 7 } }
    : node),
  links: defaultGraphs[0].links.map((link, index) => index === 0 ? { ...link, customLinkField: 'keep' } : link)
});
assert.deepEqual(preserved.extension, { future: true }, 'Graph normalization must preserve unknown graph data');
assert.equal(preserved.nodes[1].pluginNodeField, 'keep', 'Graph normalization must preserve unknown node data');
assert.equal(preserved.nodes[1].parameters.customUniform, 7, 'Graph normalization must preserve unknown parameters');
assert.equal(preserved.links[0].customLinkField, 'keep', 'Graph normalization must preserve unknown link data');

const graphEffectDocument = {
  shaderGraphs: defaultGraphs,
  postProcess: {
    enabled: true,
    effects: [{ id: 'cinematic-effect', type: 'shaderGraph', graphId: defaultGraphs[0].id, enabled: true, parameters: { 'cinematic-tint.amount': 0.5 }, futureField: true }]
  }
};
assert.deepEqual(
  DataModel.validateShaderGraphDocument(graphEffectDocument, { strict: true }).filter(item => item.severity === 'error'),
  [],
  'Post Process graph effects must resolve a canonical graphId'
);
assert.match(
  DataModel.validateShaderGraphDocument({ ...graphEffectDocument, postProcess: { effects: [{ id: 'bad', type: 'shaderGraph', graphId: 'missing', enabled: true }] } })
    .find(item => item.code === 'E_SHADER_EFFECT_GRAPH_REFERENCE')?.pointer || '',
  /^\/postProcess\/effects\/0\/graphId$/,
  'missing graph effect references must be diagnosed precisely'
);

const shaderApi = html.match(/shaders:\s*\{([\s\S]*?)\n \},\n skeletons:/)?.[1] || '';
for (const token of [
  'list:', 'current:', 'select:', 'create:', 'duplicate:', 'remove:', 'addNode:', 'removeNodes:',
  'connect:', 'disconnect:', 'setParameter:', 'compile:', 'fit:', 'addEffect:', 'reorderEffect:', 'toggleEffect:'
]) {
  assert.ok(shaderApi.includes(token), `AH2DEditorRuntime.shaders must expose ${token}`);
}

assert.match(html, /shaderGraphs:createDefaultShaderGraphs\(\)/, 'Editor state must own top-level Shader Graphs');
assert.match(html, /shaderGraphs:state\.shaderGraphs/, 'Undo history must include Shader Graph authoring');
assert.match(html, /shaderGraphs:cloneData\(state\.shaderGraphs\)/, 'EditorBridge and Project serialization must carry Shader Graphs');
assert.match(html, /normalizeEditorShaderGraphs\(Array\.isArray\(d\.shaderGraphs\)\?d\.shaderGraphs:\[\]\)/, 'Project load must normalize every Shader Graph');
assert.match(html, /assertShaderGraphDocument\(document\)/, 'Project save and export must validate Shader Graph references');
assert.match(html, /state\.shaderGraphs=cloneData\(starterShaderGraphs\)/, 'New Project must rebuild the default Shader Graph library');
assert.match(html, /shaderGraphs:state\.shaderGraphs,shaderEditor:state\.shaderEditor/, 'Play snapshots must include graph data and authoring view state');
assert.match(html, /function createShaderGraph\(/, 'graph selector must support creation');
assert.match(html, /function duplicateShaderGraph\(/, 'graph selector must support collision-safe duplication');
assert.match(html, /function deleteShaderGraph\(/, 'graph selector must support graph and effect cleanup');
assert.match(html, /function addShaderNode\(/, 'palette actions must create real nodes');
assert.match(html, /\$\('#addShaderNode'\)\.onclick=\(\)=>addShaderNode\(\$\('#shaderAddNodeType'\)\.value\)/, 'the responsive toolbar must add nodes when the palette is hidden');
assert.match(html, /type==='output'[\s\S]*A Shader Graph has one Output node/, 'palette actions must preserve the single canonical Output invariant');
assert.match(html, /function removeShaderNodes\(/, 'node selection must be removable');
assert.match(html, /function removableShaderNodeIds\([^}]*node\.type!=='output'/, 'the required Output node must be excluded from destructive selections');
assert.match(html, /node\.type==='output'[\s\S]*Every Shader Graph requires exactly one Output node\.[\s\S]*:'<div class="action-row"><button class="ibtn danger" id="deleteShaderNodes">Delete Node<\/button>/, 'the Inspector must not offer Delete for a selected Output node');
assert.match(html, /function connectShaderNodes\(/, 'ports must create canonical links');
assert.match(html, /function disconnectShaderLink\(/, 'connections must be explicitly removable');
assert.match(html, /direction==='input'[\s\S]*graph\.links\.splice\(removedIndex,1\)/, 'dragging an occupied input must detach it for reconnect or disconnect');
assert.match(html, /function cancelShaderInteraction\([\s\S]*removedLink[\s\S]*rollbackSnapshot/, 'Escape or pointer cancellation must restore a detached input link and its history checkpoint');
assert.match(html, /interaction\.kind==='nodes'&&interaction\.started[\s\S]*node\.position=[\s\S]*rollbackSnapshot/, 'cancelling a node drag must restore every authored position without leaving an undo entry');
assert.match(html, /pointercancel',event=>cancelShaderInteraction/, 'pointer cancellation must cancel rather than commit a partial graph interaction');
assert.match(html, /path\.onpointerdown=event=>\{const pan=event\.button===1\|\|shaderSpaceDown\|\|state\.shaderEditor\.tool==='pan';if\(pan\)\{path\.dataset\.shaderPanGesture='1';startShaderPan\(event\)\}/, 'Pan and Space-drag must start graph panning even over a rendered link');
assert.match(html, /path\.onclick=event=>\{event\.stopPropagation\(\);if\(path\.dataset\.shaderPanGesture==='1'[\s\S]*?return\}disconnectShaderLink\(path\.dataset\.shaderLink\)/, 'a pan gesture must not disconnect a link while a normal Select-mode click still does');
assert.match(html, /interaction\.kind==='nodes'/, 'selected nodes must support pointer dragging');
assert.match(html, /interaction\.kind==='box'/, 'empty-space dragging must box-select nodes');
assert.match(html, /interaction\.kind==='pan'/, 'the graph must support smooth pointer panning');
assert.match(html, /function shaderStartNodeDrag\(event\)\{[^}]*shaderSpaceDown\|\|state\.shaderEditor\.tool==='pan'\)\{startShaderPan\(event\);return\}[^}]*event\.button!==0/, 'Pan tool and Space-drag must take precedence over node movement');
assert.match(html, /function shaderStartPortDrag\(event\)\{[^}]*shaderSpaceDown\|\|state\.shaderEditor\.tool==='pan'\)\{startShaderPan\(event\);return\}/, 'Space-dragging or panning over a port must pan the graph instead of editing a link');
assert.match(html, /viewport\.onwheel=[\s\S]*setShaderZoom/, 'the graph must support cursor-centered wheel zoom');
assert.match(html, /function fitShaderGraph\(/, 'the graph must support fit-to-content');
assert.match(html, /function fitShaderGraph\([\s\S]*?zoom=clamp\([\s\S]*?,\.55,2\.5\)/, 'automatic Fit must keep nodes legible even when a graph is wider than the viewport');
assert.match(html, /function setShaderZoom\([\s\S]*?next=clamp\(Number\(value\)\|\|1,\.25,2\.5\)/, 'manual zoom-out must retain the wider 25% navigation range');
assert.match(html, /needsInitialFit[\s\S]*requestAnimationFrame[\s\S]*fitShaderGraph\(\)/, 'newly opened graphs must frame their complete node flow once');
assert.match(html, /activePage==='shaders'&&state\.shaderEditor\.selectedNodeIds\.length[\s\S]*removeShaderNodes\(\)/, 'Delete must remove Shader node multi-selection');
assert.match(html, /data-shader-parameter=/, 'Inspector must expose typed node parameter controls');
assert.match(html, /function shaderGraphDiagnostics\(/, 'Editor must compile and diagnose the authored graph');
assert.match(html, /Cycle detected at/, 'Editor compile status must detect graph cycles');
assert.match(html, /ah2dEngine\.shaders\.compile\(graph,\{emit:false\}\)/, 'compile status must include the real framework-neutral Engine compiler');
assert.match(html, /function evaluateShaderGraphPixels\(/, 'CPU preview must evaluate canonical graph nodes');
assert.match(html, /shaderPreviewCtx\.putImageData/, 'CPU output must be drawn into the live Canvas preview');
assert.match(html, /const effect=\{id,type:'shaderGraph',graphId:graph\.id,name:graph\.name,enabled:true,parameters:\{\}\}/, 'adding a graph effect must author the canonical Post Process descriptor');
assert.match(html, /effects\.splice\(target,0,effect\)/, 'Post Process effects must support stable reordering');
assert.match(html, /effect\.enabled=effect\.enabled===false/, 'Post Process effects must support per-effect toggles');
assert.match(html, /effect\.type==='shaderGraph'\?state\.shaderGraphs\.find/, 'the stack must resolve graph effects without replacing built-ins or unknown effects');
assert.match(html, /for\(const effect of effects\)[\s\S]*if\(!applyScenePostEffect\(effect,source,target,targetCtx,r\)\)continue;source=target/, 'Scene rendering must evaluate enabled Post Process effects in authored stack order');
assert.match(html, /function applySceneShaderGraphEffect\([\s\S]*evaluateShaderGraphPixelsWithOverrides\([\s\S]*catch\{return false\}/, 'Scene rendering must apply graph effects while safely passing through missing or invalid graphs');
assert.match(html, /function shaderEffectParameterOverrides\(/, 'Scene graph effects must accept per-effect parameter overrides');
assert.match(html, /function postEffectParameter\([\s\S]*parameters\[key\][\s\S]*effect\?\.\[key\]/, 'built-in effects must prefer canonical nested parameters with legacy flat-field fallback');
assert.match(html, /const resolved=Number\(postEffectParameter\(effect,key,min\)\)/, 'Post Process controls must display canonical nested parameters');
assert.match(html, /setPostEffectParameter\(effect,input\.dataset\.postParam,Number\(input\.value\)\)/, 'Post Process controls must update the canonical parameter location');
assert.match(html, /function scheduleShaderLiveSync\(\)\{[^}]*requestAnimationFrame/, 'Shader parameter input must throttle live Engine and Scene synchronization with requestAnimationFrame');
assert.match(html, /input\.oninput=\(\)=>\{[\s\S]*?shaderSnapshot!=='1'\)\{snapshot\(\);input\.dataset\.shaderSnapshot='1'\}[\s\S]*?scheduleShaderLiveSync\(\)/, 'one Shader Inspector gesture must create one undo checkpoint and update the live scene');
assert.doesNotMatch(html, /input\.onfocus=\(\)=>\{[^}]*shaderSnapshot[^}]*snapshot\(\)/, 'merely focusing a Shader parameter must not create an empty undo checkpoint');
assert.match(html, /input\.onchange=\(\)=>\{delete input\.dataset\.shaderSnapshot;renderShaderEditor\(\);flushShaderLiveSync\(\)\}/, 'finishing a Shader parameter gesture must flush its pending live synchronization');
assert.match(html, /Math\.floor\(\(Math\.floor\(x\/size\)\+\.5\)\*size\)/, 'Editor pixelation must sample each block center like Runtime and GLSL');
assert.match(html, /Math\.hypot\(u-\.5,v-\.5\)\*Math\.SQRT2[\s\S]*factor=1-intensity\+mask\*intensity/, 'Editor vignette math must match Runtime and GLSL');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must be present`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    else if (html[index] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${name}`);
}

const renderShaderNodesSource = extractFunction('renderShaderNodes');
const bindShaderNodeEventsSource = extractFunction('bindShaderNodeEvents');
const shaderStartNodeDragSource = extractFunction('shaderStartNodeDrag');
const finishShaderInteractionSource = extractFunction('finishShaderInteraction');
assert.match(renderShaderNodesSource, /bindShaderNodeEvents\(\)/, 'every Shader node DOM rebuild must immediately restore node and port handlers');
assert.match(bindShaderNodeEventsSource, /node\.onpointerdown=shaderStartNodeDrag/, 'rebinding must restore node selection and drag handlers');
assert.match(bindShaderNodeEventsSource, /port\.onpointerdown=shaderStartPortDrag/, 'rebinding must restore port connection and pan handlers');
assert.match(shaderStartNodeDragSource, /refreshShaderNodeSelection\(\)/, 'selection clicks must update classes without replacing the pressed node DOM');
assert.doesNotMatch(shaderStartNodeDragSource, /renderShaderNodes\(\)/, 'node pointerdown must not detach its own event target');
assert.match(finishShaderInteractionSource, /interaction\.kind==='box'[^}]*refreshShaderNodeSelection\(\)/, 'box selection completion must preserve the bound node DOM');
const fakeShaderNodes = [{ onpointerdown: null }, { onpointerdown: null }];
const fakeShaderPorts = [{ onpointerdown: null }];
const bindingContext = vm.createContext({
  $$: selector => selector === '[data-shader-node]' ? fakeShaderNodes : fakeShaderPorts,
  shaderStartNodeDrag() {},
  shaderStartPortDrag() {}
});
new vm.Script(bindShaderNodeEventsSource).runInContext(bindingContext);
bindingContext.bindShaderNodeEvents();
assert.ok(fakeShaderNodes.every(node => node.onpointerdown === bindingContext.shaderStartNodeDrag), 'every replacement node must receive the selection/drag handler');
assert.ok(fakeShaderPorts.every(port => port.onpointerdown === bindingContext.shaderStartPortDrag), 'every replacement port must receive the connection/pan handler');

const nodeMeta = Object.fromEntries(Object.entries(DataModel.SHADER_NODE_DEFINITIONS).map(([type, definition]) => [type, {
  inputs: Object.keys(definition.inputs),
  outputs: Object.keys(definition.outputs),
  defaults: Object.fromEntries(Object.entries(definition.parameters).map(([key, descriptor]) => [key, descriptor.default]))
}]));
const graphContext = vm.createContext({
  SHADER_NODE_META: nodeMeta,
  clamp: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
});
new vm.Script([
  extractFunction('shaderGraphDiagnostics'),
  extractFunction('shaderHex'),
  extractFunction('shaderInputBuffer'),
  extractFunction('evaluateShaderGraphPixels'),
  extractFunction('postEffectParameter'),
  extractFunction('setPostEffectParameter'),
  extractFunction('removableShaderNodeIds'),
  extractFunction('shaderEffectParameterOverrides'),
  extractFunction('shaderNodeParameters'),
  extractFunction('evaluateShaderGraphPixelsWithOverrides')
].join('\n')).runInContext(graphContext);

const compiled = graphContext.shaderGraphDiagnostics(defaultGraphs[0]);
assert.equal(compiled.ok, true, 'default Shader Graph must compile in the Editor');
assert.deepEqual([...compiled.order], ['cinematic-source', 'cinematic-tint', 'cinematic-vignette', 'cinematic-output']);

const missingInput = DataModel.normalizeShaderGraph({ id: 'missing-input', name: 'Missing Input' });
missingInput.links = [];
assert.equal(graphContext.shaderGraphDiagnostics(missingInput).ok, false);
assert.match(graphContext.shaderGraphDiagnostics(missingInput).errors.join('\n'), /is not connected/);

const cycleGraph = DataModel.normalizeShaderGraph({
  id: 'cycle', name: 'Cycle', version: 1, domain: 'postProcess',
  nodes: [
    { id: 'source', type: 'sceneTexture', position: { x: 0, y: 0 }, parameters: {} },
    { id: 'a', type: 'tint', position: { x: 100, y: 0 }, parameters: {} },
    { id: 'b', type: 'tint', position: { x: 200, y: 0 }, parameters: {} },
    { id: 'out', type: 'output', position: { x: 300, y: 0 }, parameters: {} }
  ],
  links: [
    { id: 'a-b', from: { nodeId: 'a', port: 'color' }, to: { nodeId: 'b', port: 'color' } },
    { id: 'b-a', from: { nodeId: 'b', port: 'color' }, to: { nodeId: 'a', port: 'color' } },
    { id: 'b-out', from: { nodeId: 'b', port: 'color' }, to: { nodeId: 'out', port: 'color' } }
  ],
  outputNodeId: 'out'
});
const cycleCompilation = graphContext.shaderGraphDiagnostics(cycleGraph);
assert.equal(cycleCompilation.ok, false, 'Editor compile must reject directed cycles');
assert.match(cycleCompilation.errors.join('\n'), /Cycle detected/);

const evaluateGraph = DataModel.normalizeShaderGraph({
  id: 'cpu', name: 'CPU Preview', version: 1, domain: 'postProcess',
  nodes: [
    { id: 'source', type: 'sceneTexture', position: { x: 0, y: 0 }, parameters: {} },
    { id: 'invert', type: 'invert', position: { x: 100, y: 0 }, parameters: { amount: 1 } },
    { id: 'mix', type: 'mix', position: { x: 200, y: 0 }, parameters: { factor: 0.5 } },
    { id: 'out', type: 'output', position: { x: 300, y: 0 }, parameters: {} }
  ],
  links: [
    { id: 'source-mix', from: { nodeId: 'source', port: 'color' }, to: { nodeId: 'mix', port: 'a' } },
    { id: 'source-invert', from: { nodeId: 'source', port: 'color' }, to: { nodeId: 'invert', port: 'color' } },
    { id: 'invert-mix', from: { nodeId: 'invert', port: 'color' }, to: { nodeId: 'mix', port: 'b' } },
    { id: 'mix-out', from: { nodeId: 'mix', port: 'color' }, to: { nodeId: 'out', port: 'color' } }
  ],
  outputNodeId: 'out'
});
const sourcePixel = new Uint8ClampedArray([10, 20, 30, 255]);
const evaluated = graphContext.evaluateShaderGraphPixels(evaluateGraph, 1, 1, sourcePixel);
assert.equal(evaluated.ok, true, 'valid graphs must render in the CPU preview');
assert.deepEqual(Array.from(evaluated.pixels), [128, 128, 128, 255], 'CPU preview must evaluate connected branches and Mix deterministically');
const runtimeEvaluated = runtimeShaders.evaluate(evaluateGraph, { color: [10 / 255, 20 / 255, 30 / 255, 1], uv: [0.5, 0.5], resolution: [1, 1] });
assert.equal(runtimeEvaluated.valid, true);
assert.deepEqual(runtimeEvaluated.color.map(channel => Math.round(channel * 255)), Array.from(evaluated.pixels), 'Canvas preview arithmetic must agree with the Engine evaluator');
const authoredBeforeOverride = JSON.stringify(evaluateGraph);
const nestedOverride = graphContext.evaluateShaderGraphPixelsWithOverrides(evaluateGraph, 1, 1, sourcePixel, { invert: { amount: 0 } });
assert.deepEqual(Array.from(nestedOverride.pixels), Array.from(sourcePixel), 'nested node parameter overrides must affect the live graph result');
const flatOverride = graphContext.evaluateShaderGraphPixelsWithOverrides(evaluateGraph, 1, 1, sourcePixel, { 'invert.amount': 1, 'mix.factor': 1 });
assert.deepEqual(Array.from(flatOverride.pixels), [245, 235, 225, 255], 'flat node.parameter overrides must affect the live graph result');
assert.equal(JSON.stringify(evaluateGraph), authoredBeforeOverride, 'effect overrides must not mutate the authored Shader Graph');
const mergedOverrides = graphContext.shaderEffectParameterOverrides({
  parameters: { invert: { amount: 0.25 }, 'mix.factor': 0.2 },
  overrides: { invert: { amount: 0.75 }, 'mix.factor': 0.8 }
});
assert.equal(mergedOverrides.invert.amount, 0.25, 'canonical effect.parameters must supply nested node overrides');
assert.equal(mergedOverrides['mix.factor'], 0.2, 'canonical effect.parameters must supply flat node.parameter overrides');
assert.equal(graphContext.postEffectParameter({ parameters: { intensity: 0.75 }, intensity: 0.2 }, 'intensity', 0), 0.75, 'built-in nested parameters must take precedence');
assert.equal(graphContext.postEffectParameter({ intensity: 0.2 }, 'intensity', 0), 0.2, 'legacy built-in flat fields must remain compatible');
const nestedBuiltIn = { parameters: { intensity: 0.25, extension: true }, intensity: 0.1 };
assert.equal(graphContext.setPostEffectParameter(nestedBuiltIn, 'intensity', 0.8), true);
assert.equal(nestedBuiltIn.parameters.intensity, 0.8, 'editing a canonical built-in effect must update its nested parameter');
assert.equal(nestedBuiltIn.parameters.extension, true, 'editing a canonical built-in effect must preserve sibling parameters');
assert.equal(nestedBuiltIn.intensity, 0.1, 'editing canonical parameters must not overwrite a conflicting legacy fallback');
const legacyBuiltIn = { intensity: 0.1 };
graphContext.setPostEffectParameter(legacyBuiltIn, 'intensity', 0.6);
assert.equal(legacyBuiltIn.intensity, 0.6, 'legacy flat built-in effects must remain editable without a migration');

const outputProtectedGraph = {
  outputNodeId: 'out',
  nodes: [{ id: 'source', type: 'sceneTexture' }, { id: 'grade', type: 'tint' }, { id: 'out', type: 'output' }]
};
assert.deepEqual([...graphContext.removableShaderNodeIds(outputProtectedGraph, ['grade', 'out'])], ['grade'], 'mixed deletion must keep Output while removing ordinary nodes');
assert.deepEqual([...graphContext.removableShaderNodeIds(outputProtectedGraph, ['out'])], [], 'Output-only deletion must be rejected before history or graph mutation');

const spatialGraph = DataModel.normalizeShaderGraph({
  id: 'spatial-parity', name: 'Spatial Parity', version: 1, domain: 'postProcess',
  nodes: [
    { id: 'spatial-source', type: 'sceneTexture', position: { x: 0, y: 0 }, parameters: {} },
    { id: 'spatial-tint', type: 'tint', position: { x: 100, y: 0 }, parameters: { color: '#80c0ff', amount: 0.35 } },
    { id: 'spatial-pixelate', type: 'pixelate', position: { x: 200, y: 0 }, parameters: { size: 2 } },
    { id: 'spatial-vignette', type: 'vignette', position: { x: 300, y: 0 }, parameters: { intensity: 0.6, softness: 0.3, radius: 0.8 } },
    { id: 'spatial-output', type: 'output', position: { x: 400, y: 0 }, parameters: {} }
  ],
  links: [
    { id: 'spatial-link-source', from: { nodeId: 'spatial-source', port: 'color' }, to: { nodeId: 'spatial-tint', port: 'color' } },
    { id: 'spatial-link-tint', from: { nodeId: 'spatial-tint', port: 'color' }, to: { nodeId: 'spatial-pixelate', port: 'color' } },
    { id: 'spatial-link-pixelate', from: { nodeId: 'spatial-pixelate', port: 'color' }, to: { nodeId: 'spatial-vignette', port: 'color' } },
    { id: 'spatial-link-output', from: { nodeId: 'spatial-vignette', port: 'color' }, to: { nodeId: 'spatial-output', port: 'color' } }
  ],
  outputNodeId: 'spatial-output'
});
const spatialWidth = 4, spatialHeight = 4, spatialSource = new Uint8ClampedArray(spatialWidth * spatialHeight * 4);
for (let y = 0; y < spatialHeight; y += 1) for (let x = 0; x < spatialWidth; x += 1) {
  const index = (y * spatialWidth + x) * 4;
  spatialSource[index] = 20 + x * 45 + y * 7;
  spatialSource[index + 1] = 30 + x * 11 + y * 39;
  spatialSource[index + 2] = 50 + x * 21 + y * 17;
  spatialSource[index + 3] = 255;
}
const spatialEditor = graphContext.evaluateShaderGraphPixels(spatialGraph, spatialWidth, spatialHeight, spatialSource);
assert.equal(spatialEditor.ok, true);
const sampleSpatial = uv => {
  const x = Math.max(0, Math.min(spatialWidth - 1, Math.floor(uv[0] * spatialWidth)));
  const y = Math.max(0, Math.min(spatialHeight - 1, Math.floor(uv[1] * spatialHeight)));
  const index = (y * spatialWidth + x) * 4;
  return Array.from(spatialSource.slice(index, index + 4), value => value / 255);
};
for (let y = 0; y < spatialHeight; y += 1) for (let x = 0; x < spatialWidth; x += 1) {
  const uv = [(x + 0.5) / spatialWidth, (y + 0.5) / spatialHeight];
  const runtimePixel = runtimeShaders.evaluate(spatialGraph, { color: sampleSpatial(uv), sample: sampleSpatial, uv, resolution: [spatialWidth, spatialHeight] });
  assert.equal(runtimePixel.valid, true);
  const runtimeBytes = runtimePixel.color.map(channel => Math.round(channel * 255));
  const editorBytes = Array.from(spatialEditor.pixels.slice((y * spatialWidth + x) * 4, (y * spatialWidth + x + 1) * 4));
  assert.ok(editorBytes.every((channel, index) => Math.abs(channel - runtimeBytes[index]) <= 1), `Editor spatial Shader result must match Runtime at ${x},${y}: ${editorBytes} vs ${runtimeBytes}`);
}
const fallback = graphContext.evaluateShaderGraphPixels(missingInput, 1, 1, sourcePixel);
assert.equal(fallback.ok, false);
assert.deepEqual(Array.from(fallback.pixels), Array.from(sourcePixel), 'invalid graphs must safely preview the unmodified scene texture');

console.log(`AH2DEdtior Shader Graph regression checks passed (${scripts.length} inline scripts parsed)`);
