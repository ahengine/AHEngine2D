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
const defaultFactorySource = html.match(/const createDefaultAnimations=\(\)=>\[[\s\S]*?\n\];/)?.[0];
assert.ok(defaultFactorySource, 'default Animation Clip factory must be present');
const defaultFactoryContext = vm.createContext({ result: null });
new vm.Script(`${defaultFactorySource}; result=createDefaultAnimations();`).runInContext(defaultFactoryContext);
const defaultAnimations = JSON.parse(JSON.stringify(defaultFactoryContext.result));
const defaultDiagnostics = DataModel.validateAnimationDocument(defaultAnimations);
assert.deepEqual(defaultDiagnostics.filter(item => item.severity === 'error'), [], 'default Animation Clips must satisfy the canonical contract');
for (const clip of defaultAnimations) {
  for (const keyframe of clip.tracks.find(track => track.type === 'sprite').keyframes) {
    assert.equal(Number.isInteger(keyframe.value.frame), true, 'default Sprite keys must use canonical value.frame');
    assert.equal('spriteFrame' in keyframe.value, false, 'default Sprite keys must not persist the legacy spriteFrame alias');
  }
}

const requiredRuntimeApi = [
  'list:', 'current:', 'select:', 'create:', 'remove:', 'sample:',
  'setFrame:', 'play:', 'pause:', 'addTrack:', 'removeTrack:', 'addKey:', 'removeKey:'
];
const animationApi = html.match(/animations:\s*\{([\s\S]*?)\n \},\n postProcess:/)?.[1] || '';
for (const token of requiredRuntimeApi) {
  assert.ok(animationApi.includes(token), `runtime Animation API must expose ${token}`);
}

for (const trackType of ['sprite', 'position', 'rotation', 'event', 'hitbox']) {
  assert.match(html, new RegExp(`${trackType}:\\{label:`), `${trackType} track must have a real Timeline presentation`);
}

assert.match(html, /animations:createDefaultAnimations\(\)/, 'Editor state must own Animation Clips');
assert.match(html, /validateAnimationDocument\(\{animations:rawAnimations,scenes,prefabs\}\)/, 'Load must validate raw Animation Clips before normalization');
assert.match(html, /normalizeEditorAnimations\(rawAnimations\)/, 'Load must hydrate validated project Animation Clips');
assert.match(html, /AH2D\.normalizeAnimationClips\(raw\)/, 'Editor and Engine must share collision-safe legacy Clip ID normalization');
assert.match(html, /animations:cloneData\(state\.animations\)/, 'Save must serialize authored Animation Clips');
assert.match(html, /assertAnimationDocument\(document\)/, 'Save and export must validate Animation Clips');
assert.match(html, /AH2D\.sampleAnimationClip\(clip,frame,\{unit:'frame',loop:clip\.loop\}\)/, 'Preview must use the shared clip sampler');
assert.match(html, /data-animation-key/, 'Timeline must render selectable keyframes');
assert.match(html, /beginAnimationKeyDrag/, 'Timeline keys must support snapped drag editing');
assert.match(html, /setAnimationPlaying\(false\);setFrame\(key\.frame,\{wrap:false\}\)/, 'selecting a key must move the playhead and Preview to that frame');
assert.match(html, /setAnimatorTool\('pan'\)/, 'Animator hand tool must enable Timeline panning');
assert.match(html, /timelinePan\.element\.scrollLeft=/, 'Timeline panning must move the scroll viewport');
assert.match(html, /setAnimatorGrid\(!state\.animator\.grid\)/, 'Animator grid toolbar button must be functional');
assert.match(html, /data-add-component="animation"/, 'Scene objects must be able to bind an Animation Clip through Add Component');
assert.match(html, /writeEditorComponent\(o,'Animation'/, 'Animation bindings must be authored as a real ECS component');
assert.match(html, /writeEditorComponent\(o,'Animation',\{clipId:clip\.id,autoplay:true\}\)/, 'a new Animation binding must inherit Clip speed and loop until explicitly overridden');
assert.doesNotMatch(html, /writeEditorComponent\(o,'Animation',\{clipId:clip\.id,autoplay:true,speed:1,loop:clip\.loop\}\)/, 'a new Animation binding must not freeze Clip speed and loop as Component overrides');
assert.match(html, /data-animation-binding="clipId"/, 'Animation component Inspector must expose its Clip binding');
assert.match(html, /addAnimationTrack\(type,targetEntityId/, 'Timeline must support multiple target-aware tracks of the same type');
assert.match(html, /data-animation-track-prop="targetEntityId"/, 'Selected tracks must expose their target Entity');
assert.match(html, /addAnimationKeyframe/, 'Timeline must support key creation');
assert.match(html, /removeAnimationKeyframe/, 'Timeline must support key removal');
assert.match(html, /state\.animator\.playbackTime\+=dt\*speed/, 'Playback must accumulate time without discarding the remainder');
assert.match(html, /clip\.loop&&duration>0/, 'Playback must distinguish looping and non-looping clips');
assert.match(html, /!Number\.isFinite\(state\.animator\.playbackTime\)/, 'Rendering must initialize playback time only when it is invalid');
assert.match(html, /format:'AH2D\.Animation',version:1/, 'Export must emit the selected Animation Clip dialect');
assert.match(html, /data-animation-key-value="frame"/, 'Sprite keys must author canonical Renderable.frame values');
assert.match(html, /data-animation-source-toggle/, 'Sprite keys must support an actual sourceRect crop');
assert.match(html, /window\.addEventListener\('pointercancel',finishAnimatorPointer\)/, 'Timeline gestures must clean up on pointer cancellation');
assert.match(html, /animatorTimelineBounds\(\)/, 'Timeline resize must clamp to the current Animator viewport');
assert.match(html, /activePage!=='edit'\|\|state\.playMode/, 'Animator keys must not mutate the hidden Scene camera');
assert.match(html, /animations:state\.animations/, 'Undo history must include Animation Clip authoring data');
assert.doesNotMatch(html, /const frameIcons=/, 'Timeline must not use the old hardcoded frame icon strip');
assert.doesNotMatch(html, /254\+state\.animator\.frame\*48/, 'Playhead must not use the old fixed pixel offset');
assert.match(html, /margin-left:var\(--anim-left-gutter\);margin-right:var\(--anim-right-gutter\)/, 'Timeline must stay inside the space left by open side panels');

const editorFunctionSource = name => {
  const source = html.match(new RegExp(`function ${name}\\([^\\r\\n]+`))?.[0];
  assert.ok(source, `${name} must be extractable for executable regression testing`);
  return source;
};

const trackContext = vm.createContext({
  state: { animator: { selectedTrackId: 'tree-position' } },
  animationPreviewTargetId: () => null,
  animationTrack: clip => clip.tracks.find(track => track.id === 'tree-position'),
  sampleEditorAnimationClip: () => ({ tracks: [
    { trackId: 'knight-position', type: 'position', targetEntityId: 'knight', value: { x: 830, y: 800 } }
  ] }),
  animationEntityById: id => id === 'tree' ? { id, local: { x: 330, y: 620, rot: 0 } } : null,
  editorLocalTransform: entity => entity.local,
  editorRenderable: () => ({}),
  editorObjectIcon: () => '◇',
  cloneData: value => JSON.parse(JSON.stringify(value))
});
new vm.Script(`${editorFunctionSource('sampledAnimationTrack')};${editorFunctionSource('defaultAnimationKeyValue')}`).runInContext(trackContext);
const multiTargetSample = { tracks: [
  { trackId: 'knight-old', type: 'position', targetEntityId: 'knight', value: { x: 1, y: 1 } },
  { trackId: 'tree-position', type: 'position', targetEntityId: 'tree', value: { x: 2, y: 2 } },
  { trackId: 'knight-new', type: 'position', targetEntityId: 'knight', value: { x: 3, y: 3 } }
] };
assert.equal(trackContext.sampledAnimationTrack(multiTargetSample, 'position', 'missing'), null, 'an explicit target must never fall back to another Entity');
assert.deepEqual(JSON.parse(JSON.stringify(trackContext.sampledAnimationTrack(multiTargetSample, 'position', 'knight').value)), { x: 3, y: 3 }, 'Preview must use the Runtime last-track-wins precedence');
assert.equal(trackContext.sampledAnimationTrack(multiTargetSample, 'position', 'knight', 'knight-old').trackId, 'knight-old', 'selected-track sampling must remain exact');
const emptyTreeTrack = { id: 'tree-position', type: 'position', targetEntityId: 'tree', keyframes: [] };
assert.deepEqual(JSON.parse(JSON.stringify(trackContext.defaultAnimationKeyValue('position', { targetEntityId: 'knight', tracks: [emptyTreeTrack] }, 4, emptyTreeTrack.id))), { x: 330, y: 620 }, 'a new key on an empty track must start from its own target Transform');

const assetContext = vm.createContext({ state: { assets: [], animations: [] } });
new vm.Script(`${editorFunctionSource('animationAssetForClip')};${editorFunctionSource('reconcileAnimationAssets')}`).runInContext(assetContext);
const duplicateNameClips = [{ id: 'clip-a', name: 'Shared' }, { id: 'clip-b', name: 'Shared' }];
const duplicateNameAssets = [
  { id: 'asset-a', kind: 'animation', name: 'Shared.anim', animationId: 'clip-a' },
  { id: 'legacy-shared', kind: 'animation', name: 'Shared.anim' }
];
assetContext.reconcileAnimationAssets(duplicateNameAssets, duplicateNameClips);
assert.equal(duplicateNameAssets[0].animationId, 'clip-a', 'a stable Animation Asset binding must never be stolen');
assert.equal(duplicateNameAssets.find(asset => asset.animationId === 'clip-b')?.id, 'animation-clip-b', 'duplicate Clip names must receive distinct stable Assets');
assert.equal(duplicateNameAssets.find(asset => asset.id === 'legacy-shared').animationId, undefined, 'ambiguous legacy name Assets must remain unbound');
const uniqueAssets = [{ id: 'legacy-idle', kind: 'animation', name: 'Idle.anim' }];
assetContext.reconcileAnimationAssets(uniqueAssets, [{ id: 'idle', name: 'Idle' }]);
assert.equal(uniqueAssets[0].animationId, 'idle', 'a unique unbound legacy name may be reconciled once');

const runtimeEntity = { components: { Animation: { clipId: 'run', playing: false, time: 0 } } };
const runtimeContext = vm.createContext({
  RUNTIME_PROFILE: 'runtime',
  cloneData: value => JSON.parse(JSON.stringify(value)),
  readRuntimeEditorComponent: entity => entity.components.Animation,
  resolveRuntimeEditorComponent: () => ({ found: true, provenance: 'components.Animation' }),
  entityCodec: { write(entity, type, value, options) { assert.equal(options.profile, 'runtime'); entity.components[type] = value; } },
  state: { playMode: 'playing' }
});
new vm.Script(`${editorFunctionSource('syncRuntimeAnimationComponent')};${editorFunctionSource('animationInspectorStatus')}`).runInContext(runtimeContext);
assert.equal(runtimeContext.syncRuntimeAnimationComponent(runtimeEntity, { clipId: 'run', playing: true, time: 0.2, frame: 2, completed: false }), true);
assert.equal(runtimeEntity.components.Animation.frame, 2, 'Play sync must retain Runtime-only Animation fields');
assert.equal(runtimeContext.animationInspectorStatus(runtimeEntity.components.Animation, 'playing'), 'Playing');
assert.equal(runtimeContext.animationInspectorStatus(runtimeEntity.components.Animation, 'paused'), 'Paused');
runtimeEntity.components.Animation.playing = false;
runtimeEntity.components.Animation.completed = true;
assert.equal(runtimeContext.animationInspectorStatus(runtimeEntity.components.Animation, 'playing'), 'Completed');

const playbackSource = html.match(/function updateAnimatorPlayback\(dt\)\{[^\r\n]+/)?.[0];
assert.ok(playbackSource, 'playback implementation must be extractable for deterministic regression testing');
const playbackState = { animator: { playing: true, playbackTime: 0.01, frame: 0 } };
const playbackClip = { fps: 10, frameCount: 10, loop: true, speed: 1 };
const playbackContext = vm.createContext({
  state: playbackState,
  activeAnimationClip: () => playbackClip,
  clamp: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)),
  renderAnimationPreview() {},
  updateAnimationFrameUI() {}
});
new vm.Script(`${playbackSource}; updateAnimatorPlayback(.06); updateAnimatorPlayback(.06);`).runInContext(playbackContext);
assert.equal(playbackState.animator.frame, 1, 'playback must advance after accumulated sub-frame updates');
assert.ok(Math.abs(playbackState.animator.playbackTime - 0.13) < 1e-9, 'playback must retain the sub-frame time remainder');

playbackClip.loop = false;
playbackState.animator.playing = true;
playbackState.animator.playbackTime = 0.95;
new vm.Script('updateAnimatorPlayback(.2)').runInContext(playbackContext);
assert.equal(playbackState.animator.playing, false, 'non-looping playback must stop at the final frame');
assert.equal(playbackState.animator.frame, 9, 'non-looping playback must remain on the final frame');

console.log(`AH2DEdtior Animation regression checks passed (${scripts.length} inline scripts parsed)`);
