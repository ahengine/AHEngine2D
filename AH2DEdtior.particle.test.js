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

assert.ok(
  html.indexOf('const PARTICLE_CURVE_DEFAULTS=Object.freeze') < html.indexOf('new ResizeObserver'),
  'Particle Curve defaults must initialize before the first synchronous Editor resize'
);
assert.match(html, /\.body:not\(\.left-closed\) \.particle-page\{--particle-left-gutter:/, 'Particle workspace must reserve the visible left overlay inset');
assert.match(html, /\.body:not\(\.right-closed\) \.particle-page\{--particle-right-gutter:/, 'Particle workspace must reserve the visible Inspector inset');
assert.match(html, /\.curves\{[^}]*margin-left:var\(--particle-left-gutter\)[^}]*margin-right:var\(--particle-right-gutter\)/, 'Particle Curve editor must fit between open side panels');
assert.match(html, /\.particle-controls\{[^}]*right:calc\(var\(--particle-right-gutter\) \+ 10px\)/, 'Particle preview controls must remain outside the Inspector overlay');
assert.match(html, /class="curve-toolbar-group particle-asset-toolbar"[\s\S]*class="curve-toolbar-group particle-curve-toolbar"/, 'Particle and Curve actions must form responsive toolbar groups');
assert.match(html, /function particlePreviewBounds\(\)/, 'Particle preview origin must follow the unobscured stage bounds without resizing its canvas');
assert.match(html, /new ResizeObserver\(\(\)=>\{sizeCanvas\(curve,cctx,curve\.parentElement\);drawCurves\(\)\}\)\.observe\(curve\.parentElement\)/, 'Curve canvas backing size must follow animated overlay insets');

const DataModel = require('./engine/AH2DDataModel.js');
global.window = global;
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};
require('./engine/AH2DEngine.js');
const AH2D = global.AH2D;

const editorFunctionSource = name => {
  const source = html.match(new RegExp(`function ${name}\\([^\\r\\n]+`))?.[0];
  assert.ok(source, `${name} must be extractable for executable regression testing`);
  return source;
};

const defaultFactorySource = html.match(/const createDefaultParticles=\(\)=>\[[\s\S]*?\r?\n\];(?=\r?\nconst createDefaultAnimations)/)?.[0];
assert.ok(defaultFactorySource, 'default Particle Asset factory must be present');
const defaults = new Function('AH2D', `${defaultFactorySource}; return createDefaultParticles();`)({ DataModel });
assert(defaults.length >= 3, 'the Particle workspace must start with useful canonical Assets');
assert.deepEqual(DataModel.validateParticleDocument({ particles: defaults }).filter(item => item.severity === 'error'), []);
assert.equal(new Set(defaults.map(asset => asset.id)).size, defaults.length, 'default Particle IDs must be stable and unique');
for (const asset of defaults) {
  assert(asset.duration > 0, 'Particle duration must be positive');
  assert.equal(new Set(asset.curves.map(curve => curve.id)).size, asset.curves.length, 'Curve IDs must be unique per Asset');
  for (const curve of asset.curves) {
    assert(['emission', 'scale', 'speed', 'opacity', 'hue'].includes(curve.property));
    assert(['linear', 'step', 'cubic'].includes(curve.interpolation));
    for (const key of curve.keys) assert(key.time >= 0 && key.time <= 1, 'Curve key time must be normalized');
  }
}
const roundTrip = DataModel.normalizeParticleAssets(JSON.parse(JSON.stringify(defaults)));
assert.deepEqual(roundTrip, defaults, 'canonical Particle Assets must round-trip through JSON and normalization');
const legacy = DataModel.normalizeParticleAsset({ name: 'Legacy Puff', amount: 9, rate: 4, lifetime: 2, speed: 7, extension: { keep: true } });
assert.equal(legacy.maxParticles, 9, 'legacy amount must migrate to maxParticles');
assert.equal(legacy.emission.rate, 4, 'legacy rate must migrate to emission.rate');
assert.deepEqual(legacy.extension, { keep: true }, 'legacy migration must preserve unknown fields');

const particleApi = html.match(/particles:\s*\{([\s\S]*?)\n \},\n skeletons:/)?.[1] || '';
for (const token of ['list:', 'current:', 'select:', 'create:', 'duplicate:', 'remove:', 'sample:', 'addCurve:', 'removeCurve:', 'addKey:', 'removeKey:', 'setTime:']) {
  assert.ok(particleApi.includes(token), `runtime Particle API must expose ${token}`);
}

assert.match(html, /particleAssets:createDefaultParticles\(\)/, 'Editor state must own a Particle Asset library');
assert.doesNotMatch(html, /\bstate\.particle\b|particleIncluded|createDefaultParticle\(\)|particleEmitAcc/, 'removed singleton Particle state must not return');
assert.match(html, /particles:cloneData\(state\.particleAssets\)/, 'EditorBridge sync must carry the Particle Asset library');
assert.match(html, /particles:cloneData\(state\.particleAssets\)\}\s*;/, 'project save must serialize every Particle Asset');
assert.match(html, /normalizeParticleAssets\(Array\.isArray\(d\.particles\)\?d\.particles:\[\]\)/, 'load must normalize every top-level Particle Asset');
assert.match(html, /assertParticleDocument\(document,\{entityCodec\}\)/, 'save and export must validate canonical Particle data');
assert.match(html, /format:'AH2D\.Particle',version:1/, 'Particle export must use the standalone canonical dialect');
assert.match(html, /particleAssetForProjectAsset\(a\)/, 'Project items must resolve their stable particleId binding');
assert.match(html, /writeEditorComponent\(o,'ParticleEmitter',\{assetId:particleAsset\.id/, 'dropping a Particle Asset must author a bound ParticleEmitter');
assert.match(html, /entityCodec\.write\(o,'Renderable',\{kind:'particle'[\s\S]*?opacity:0,editorProxy:true/, 'a dropped Particle must keep its Editor proxy while hiding the base Pixi visual');
assert.match(html, /data-add-component="particle"/, 'Add Component must expose ParticleEmitter authoring');
assert.match(html, /new AH2D\.ParticleSystem\(/, 'Particle Editor preview must use the real Runtime system');
assert.match(html, /AH2D\.DataModel\.sampleParticleCurve\(/, 'Curve rendering and preview must use the shared sampler');
assert.match(html, /particlePreviewSystem\.snapshot\(\)/, 'live Asset edits must preserve exact Particle simulation state');
assert.match(html, /particlePreviewSystem\.restore\(runtimeSnapshot\)/, 'live Asset edits must restore cycle and fixed-step state');
assert.match(html, /particlePreviewSystem\.play\('editor-preview',\{fromStart:true,time:0,loop:asset\.loop\}\)/, 'scrubbing must retain real loop semantics');
assert.match(html, /refreshParticlePreviewAsset\(true\);syncEngineDocument\(\)/, 'Curve mutations must refresh Runtime cache and sync the Engine document');
assert.match(html, /finishParticleCurveDrag[\s\S]*refreshParticlePreviewAsset\(true\);syncEngineDocument\(\)/, 'Curve drag completion must refresh and sync once');
assert.match(html, /id="particleCurveEditor"/, 'Particle workspace must expose an interactive Curve canvas');
assert.match(html, /\.ondblclick=event=>[\s\S]*addParticleCurveKey/, 'double-clicking the Curve canvas must add a key');
assert.match(html, /removeParticleCurveKey\(\)/, 'selected keys must be removable');
assert.match(html, /appearance\.assetId/, 'Appearance Inspector must author an optional texture Asset');
assert.match(html, /function particlePreviewImage\(/, 'Particle preview must resolve texture-backed Assets');
assert.match(html, /Number\(asset\.appearance\.size\)\|\|4/, 'preview radius must not depend on a missing Runtime particle.size field');
assert.match(html, /if\('filter'in ctx\)ctx\.filter=`hue-rotate/, 'texture preview must follow the authored Hue curve');
assert.match(html, /else if\(kind==='particle'\)\{if\(state\.playMode==='stopped'&&!hasRuntimeParticles\)/, 'Particle proxies must appear only while authoring and never fall through to the generic Play renderer');
assert.match(html, /if\(hasRuntimeParticles\)drawRuntimeParticleEmitter/, 'Custom Canvas Play must render Runtime ParticleEmitter records');
assert.match(html, /activeAssetId=candidate\.id/, 'new Asset selection must use the normalized stable ID');
assert.match(html, /function uniqueParticleCurveId\(/, 'new Curves must avoid imported Curve ID collisions');
assert.match(html, /if\(input\.dataset\.particleText==='name'&&!particleAsset\.name\.trim\(\)\)\{particleAsset\.name=particleAsset\.id/, 'Asset names must remain valid when an input is cleared');
assert.match(html, /particleAssets:state\.particleAssets/, 'Undo history must include Particle Asset authoring data');
assert.match(html, /state\.particleAssets=cloneData\(starterParticleAssets\)/, 'New Project must rebuild the canonical Particle library');

const keyContext = vm.createContext({ clamp: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)) });
new vm.Script(`${editorFunctionSource('uniqueParticleCurveId')};${editorFunctionSource('uniqueParticleKeyId')};${editorFunctionSource('availableParticleKeyTime')}`).runInContext(keyContext);
const collisionAsset = { id: 'spark', curves: [{ id: 'spark-hue' }, { id: 'spark-hue-2' }] };
assert.equal(keyContext.uniqueParticleCurveId(collisionAsset, 'hue'), 'spark-hue-3', 'Curve IDs must skip arbitrary imported collisions');
const curveWithCollision = { id: 'curve', keys: [{ id: 'curve-5000', time: 0.5 }, { id: 'custom', time: 0.5001 }] };
assert.equal(keyContext.uniqueParticleKeyId(curveWithCollision, 0.5), 'curve-5000-2');
assert.equal(keyContext.availableParticleKeyTime(curveWithCollision, 0.5), 0.4999, 'new key times must remain unique without replacing imported keys');
assert.equal(keyContext.availableParticleKeyTime(curveWithCollision, 0.5, curveWithCollision.keys[0]), 0.5, 'dragging a key may retain its own time');

const projectContext = vm.createContext({ state: { particleAssets: [
  { id: 'a', name: 'Shared' }, { id: 'b', name: 'Shared' }, { id: 'unique', name: 'Unique' }
] } });
new vm.Script(editorFunctionSource('particleAssetForProjectAsset')).runInContext(projectContext);
assert.equal(projectContext.particleAssetForProjectAsset({ kind: 'particle', id: 'project-a', particleId: 'a' }).id, 'a', 'stable particleId must win over display names');
assert.equal(projectContext.particleAssetForProjectAsset({ kind: 'particle', id: 'legacy', name: 'Shared.particle' }), null, 'ambiguous legacy names must not bind silently');
assert.equal(projectContext.particleAssetForProjectAsset({ kind: 'particle', id: 'legacy-unique', name: 'Unique.particle' }).id, 'unique', 'a unique legacy name may reconcile');

const reconcileContext = vm.createContext({});
new vm.Script(editorFunctionSource('reconcileParticleAssets')).runInContext(reconcileContext);
const projectAssets = [{ id: 'legacy', kind: 'particle', name: 'Spark.particle' }];
reconcileContext.reconcileParticleAssets(projectAssets, [
  { id: 'spark', name: 'Spark', appearance: { color: '#fff' } },
  { id: 'smoke', name: 'Smoke', appearance: { color: '#aaa' } }
]);
assert.equal(projectAssets[0].particleId, 'spark', 'legacy Project metadata must acquire a stable binding');
assert.equal(projectAssets.find(asset => asset.particleId === 'smoke').id, 'particle-smoke', 'missing Particle Project items must be created predictably');

const entityCodec = DataModel.createDefaultEntityCodec();
const prepareSource = html.match(/function prepareEditorEntities\(objects\)\{[\s\S]*?\r?\n\}/)?.[0];
assert.ok(prepareSource, 'prepareEditorEntities must be extractable');
const prepareContext = vm.createContext({
  cloneData: value => JSON.parse(JSON.stringify(value)),
  AUTHORING_PROFILE: DataModel.PROFILES.AUTHORING,
  entityCodec,
  resolveEditorComponent: (entity, type) => entityCodec.resolve(entity, type, { profile: DataModel.PROFILES.AUTHORING })
});
new vm.Script(prepareSource).runInContext(prepareContext);
const preparedEmitter = prepareContext.prepareEditorEntities([{
  id: 'emitter',
  components: { ParticleEmitter: {
    assetId: 'spark', autoplay: true, playing: true, loop: true, time: 0.4, speed: 1, emitting: true,
    overrides: {}, seed: 7, particles: [{ id: 'emitter:0', x: 1, y: 2, vx: 3, vy: 4, age: 0.1, lifetime: 1 }],
    emissionAccumulator: 0.5, completed: false, rngState: 42, extension: { keep: true }
  } }
}])[0].components.ParticleEmitter;
for (const runtimeField of ['particles', 'emissionAccumulator', 'completed', 'rngState']) {
  assert.equal(runtimeField in preparedEmitter, false, `${runtimeField} must not persist into authoring JSON`);
}
assert.equal(preparedEmitter.assetId, 'spark');
assert.deepEqual(preparedEmitter.extension, { keep: true }, 'unknown ParticleEmitter authoring fields must survive runtime stripping');

const burstAsset = DataModel.normalizeParticleAsset({
  id: 'burst', name: 'Burst', duration: 1, loop: true, maxParticles: 10,
  emission: { rate: 0, burst: 3 }, lifetime: { min: 10, max: 10 },
  velocity: { speedMin: 0, speedMax: 0, angle: 0, spread: 0, gravityX: 0, gravityY: 0 },
  shape: { type: 'point', radius: 0, width: 0, height: 0 },
  appearance: { color: '#fff', blend: 'normal', baseScale: 1, baseOpacity: 1, baseHue: 0 }, curves: []
});
const previewEmitter = { assetId: 'burst', autoplay: true, playing: true, loop: true, time: 0, speed: 1, emitting: true, overrides: {}, seed: 9, particles: [], emissionAccumulator: 0, completed: false };
const previewEvents = { on: () => () => {}, emit: () => {} };
const previewEcs = {
  entities: new Map([['editor-preview', {}]]),
  query: type => type === 'ParticleEmitter' ? ['editor-preview'] : [],
  get: (id, type) => id === 'editor-preview' && type === 'ParticleEmitter' ? previewEmitter : null
};
const previewSystem = new AH2D.ParticleSystem({ ecs: previewEcs, events: previewEvents }, { seed: 9, fixedStep: 1 / 120 });
previewSystem.load({ particles: [burstAsset] });
previewSystem.initialize();
previewSystem.restart('editor-preview', { clear: true, loop: true });
assert.equal(previewEmitter.particles.length, 3, 'Runtime fixture must begin with one burst');
const previewState = { particleAssets: [burstAsset], particleEditor: { time: 0, playing: true, rngState: previewEmitter.rngState }, particlePreviewParticles: previewEmitter.particles };
const previewContext = vm.createContext({
  state: previewState,
  particlePreviewSystem: previewSystem,
  particlePreviewEmitter: previewEmitter,
  activeParticleAsset: () => burstAsset,
  syncParticlePreviewState() {
    previewState.particlePreviewParticles = previewEmitter.particles;
    previewState.particleEditor.time = previewEmitter.time;
    previewState.particleEditor.playing = previewEmitter.playing === true;
    return previewEmitter;
  }
});
new vm.Script(editorFunctionSource('refreshParticlePreviewAsset')).runInContext(previewContext);
burstAsset.appearance.color = '#ff00ff';
previewContext.refreshParticlePreviewAsset(true);
previewSystem.update(1 / 120);
assert.equal(previewEmitter.particles.length, 3, 'refresh at time zero must not emit the cycle burst twice');
assert.equal(previewSystem.resolve('burst').appearance.color, '#ff00ff', 'live edits must refresh the Runtime Asset clone');

previewContext.clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
previewContext.drawParticles = () => {};
previewContext.drawCurves = () => {};
previewContext.resetParticlePreview = restart => {
  previewState.particleEditor.time = 0;
  previewState.particleEditor.playing = Boolean(restart);
  previewSystem.load({ particles: [burstAsset] });
  Object.assign(previewEmitter, { assetId: 'burst', autoplay: true, playing: Boolean(restart), loop: true, time: 0, speed: 1, emitting: Boolean(restart), overrides: {}, seed: 9, particles: [], emissionAccumulator: 0, completed: false, rngState: 9 });
  previewSystem.initialize();
  if (restart) previewSystem.restart('editor-preview', { clear: true });
  else previewSystem.stop('editor-preview', { clear: true });
  previewContext.syncParticlePreviewState();
};
new vm.Script(editorFunctionSource('setParticlePreviewTime')).runInContext(previewContext);
previewState.particleEditor.playing = true;
previewContext.setParticlePreviewTime(burstAsset.duration);
previewSystem.update(1 / 60);
assert.equal(previewEmitter.playing, true, 'a looping Preview scrubbed to its boundary must keep playing');
assert(previewEmitter.time > 0, 'a looping Preview scrubbed to its boundary must advance into the next cycle');

console.log(`AH2DEdtior Particle regression checks passed (${scripts.length} inline scripts parsed)`);
