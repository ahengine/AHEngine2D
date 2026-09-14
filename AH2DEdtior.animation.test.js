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

for (const trackType of ['sprite', 'position', 'rotation', 'bone', 'ik', 'event', 'hitbox']) {
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
assert.match(html, /id="skeletonOverlay"/, 'Animator must own a real selectable Skeleton overlay');
assert.match(html, /buildEditorSkeletonPose/, 'Animator must compute sampled Bone and IK poses');
assert.match(html, /deformEditorSkinVertices/, 'Animator must preview CPU linear-blend Skin deformation');
assert.match(html, /animationKeyNumberField\('Scale X','scaleX'/, 'Bone keys must expose local scale authoring');
assert.match(html, /data-animation-key-value="bendDirection"/, 'IK keys must expose solver direction authoring');
assert.match(html, /data-add-component="skeleton"/, 'Add Component must expose Skeleton authoring');
assert.match(html, /data-add-component="bone"/, 'Add Component must expose nested Bone authoring');
assert.match(html, /data-add-component="ik"/, 'Add Component must expose IK target authoring');
assert.match(html, /data-add-component="skin"/, 'Add Component must expose Skin binding');
assert.match(html, /assertSkeletonDocument\(document,\{entityCodec\}\)/, 'Save and export must validate Skeleton references');
assert.match(html, /assertSkeletonDocument\(d,\{entityCodec\}\)/, 'Load must validate raw Skeleton data before Editor hydration');
assert.match(html, /for\(const type of \['Transform','Skeleton','Bone','IK','Skin'\]\)/, 'authoring serialization must normalize every runtime-bearing rig component');
assert.match(html, /prefab:preserveLoadedLegacyPrefab\?prepareEditorEntities\(base\.prefab\)/, 'legacy Prefab mirrors must use the same authoring normalization');
assert.match(html, /originalRotations=new Map/, 'IK Preview must retain its unsolved pose for one-shot mix blending');
assert.match(html, /delta\*mix/, 'IK Preview must blend the fully solved rotation only once');
assert.match(html, /seed\.rot\+=bendDirection\*\.1/, 'IK Preview must deterministically seed straight contracting chains');
assert.match(html, /radians=Math\.PI\*bendDirection/, 'IK Preview must honor bendDirection at the opposite-vector singularity');
assert.match(html, /bone\.inheritRotation===false\|\|bone\.inheritScale===false/, 'Bone Preview matrices must honor inheritance flags');
assert.match(html, /skeletonRootForEntity\(objects,entity\)\?\.id!==pose\.root\.id/, 'Animator overlay must only draw Bones owned by the selected Skeleton');
assert.match(html, /return reached\?chain:\[\]/, 'IK chain authoring must reject a tip outside the selected Skeleton');

const editorFunctionSource = name => {
  const source = html.match(new RegExp(`function ${name}\\([^\\r\\n]+`))?.[0];
  assert.ok(source, `${name} must be extractable for executable regression testing`);
  return source;
};

const entityCodec = DataModel.createDefaultEntityCodec();
const prepareSource = html.match(/function prepareEditorEntities\(objects\)\{[\s\S]*?\n\}/)?.[0];
assert.ok(prepareSource, 'prepareEditorEntities must be extractable');
const prepareContext = vm.createContext({
  cloneData: value => JSON.parse(JSON.stringify(value)),
  AUTHORING_PROFILE: DataModel.PROFILES.AUTHORING,
  entityCodec,
  resolveEditorComponent: (entity, type) => entityCodec.resolve(entity, type, { profile: DataModel.PROFILES.AUTHORING })
});
new vm.Script(prepareSource).runInContext(prepareContext);
const preparedRig = prepareContext.prepareEditorEntities([{
  id: 'rig',
  components: {
    Skeleton: { rootBoneId: 'hip', pose: { hip: { rotation: 12 } }, boneMatrices: { hip: [1, 0, 0, 1, 0, 0] }, extension: true },
    Skin: { skeletonRootId: 'rig', vertices: [], deformedVertices: [{ x: 1, y: 2 }], extension: true }
  }
}])[0];
assert.equal('pose' in preparedRig.components.Skeleton, false, 'Skeleton.pose must never persist in authoring JSON');
assert.equal('boneMatrices' in preparedRig.components.Skeleton, false, 'Skeleton.boneMatrices must never persist in authoring JSON');
assert.equal('deformedVertices' in preparedRig.components.Skin, false, 'Skin.deformedVertices must never persist in authoring JSON');
assert.equal(preparedRig.components.Skeleton.extension, true, 'authoring normalization must preserve unknown Skeleton fields');

const poseContext = vm.createContext({
  state: { sceneSelected: 'rig' },
  IDENTITY_MATRIX: Object.freeze([1, 0, 0, 1, 0, 0]),
  TRANSFORM_EPSILON: 1e-8,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  readEditorComponent: (entity, type) => entity?.components?.[type] || null,
  editorLocalTransform: entity => ({ x: 0, y: 0, rot: 0, sx: 1, sy: 1, ...(entity?.local || {}) }),
  rigReferenceEntity: (objects, owner, id) => objects.find(entity => entity.id === id) || null,
  skeletonRootForEntity: (objects, entity) => objects.find(item => item.id === (entity?.rootId || entity?.id) && item.components?.Skeleton) || null
});
new vm.Script([
  editorFunctionSource('multiplyTransform'), editorFunctionSource('transformPoint'), editorFunctionSource('decomposeTransform'),
  editorFunctionSource('matrixFromEditorPose'), editorFunctionSource('skeletalPoseMatrices'), editorFunctionSource('buildEditorSkeletonPose')
].join(';')).runInContext(poseContext);
const inheritanceObjects = [
  { id: 'parent' },
  { id: 'bone', parentId: 'parent', components: { Bone: { length: 10, inheritRotation: false, inheritScale: false } } }
];
const inheritanceMatrices = poseContext.skeletalPoseMatrices(inheritanceObjects, new Map([
  ['parent', { x: 0, y: 0, rot: 90, sx: 2, sy: 2 }],
  ['bone', { x: 10, y: 0, rot: 15, sx: 3, sy: 4 }]
]));
const inheritedBone = inheritanceMatrices.get('bone');
assert(Math.abs(inheritedBone[4]) < 1e-7 && Math.abs(inheritedBone[5] - 20) < 1e-7, 'non-inheriting Bone origin must still follow its parent Transform');
assert(Math.abs(Math.atan2(inheritedBone[1], inheritedBone[0]) * 180 / Math.PI - 15) < 1e-7, 'inheritRotation=false must retain local Bone rotation');
assert(Math.abs(Math.hypot(inheritedBone[0], inheritedBone[1]) - 3) < 1e-7, 'inheritScale=false must retain local Bone scale');

const rigForBend = (bendDirection, mix) => [
  { id: 'rig', rootId: 'rig', components: { Skeleton: { rootBoneId: 'hip', enabled: true, solveIK: true } }, local: {} },
  { id: 'hip', rootId: 'rig', parentId: 'rig', components: { Bone: { length: 100 } }, local: {} },
  { id: 'knee', rootId: 'rig', parentId: 'hip', components: { Bone: { length: 100 } }, local: { x: 100 } },
  { id: 'target', rootId: 'rig', parentId: 'rig', components: { IK: { skeletonRootId: 'rig', bones: ['hip', 'knee'], mix, iterations: 24, tolerance: 0.01, bendDirection } }, local: { x: 100 } }
];
const solvedPositive = poseContext.buildEditorSkeletonPose({ id: 'bend', targetEntityId: 'rig' }, { tracks: [] }, rigForBend(1, 1));
const solvedNegative = poseContext.buildEditorSkeletonPose({ id: 'bend', targetEntityId: 'rig' }, { tracks: [] }, rigForBend(-1, 1));
assert(solvedPositive.locals.get('hip').rot * solvedNegative.locals.get('hip').rot < 0, 'bendDirection must choose opposite sides for a singular straight chain');
const solvedHalf = poseContext.buildEditorSkeletonPose({ id: 'bend', targetEntityId: 'rig' }, { tracks: [] }, rigForBend(1, 0.5));
const fullRotation = solvedPositive.locals.get('hip').rot;
const expectedHalfRotation = (((fullRotation + 540) % 360) - 180) * 0.5;
assert(Math.abs(solvedHalf.locals.get('hip').rot - expectedHalfRotation) < 1e-7, 'IK mix must blend once after reaching the full solve');

const trackContext = vm.createContext({
  state: { animator: { selectedTrackId: 'tree-position' } },
  animationPreviewTargetId: () => null,
  animationRigOwner: () => null,
  animationRigTargetEntity: id => id === 'tree' ? { id, local: { x: 330, y: 620, rot: 0 } } : null,
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

const deformContext = vm.createContext({
  invertTransform(matrix) {
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    return [matrix[3] / determinant, -matrix[1] / determinant, -matrix[2] / determinant, matrix[0] / determinant,
      (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / determinant,
      (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / determinant];
  },
  transformPoint: (matrix, x, y) => ({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] }),
  rigReferenceEntity: (objects, owner, id) => objects.find(entity => entity.id === id) || null
});
new vm.Script(editorFunctionSource('deformEditorSkinVertices')).runInContext(deformContext);
const identity = [1, 0, 0, 1, 0, 0];
const skinEntity = { id: 'skin' };
const deformed = deformContext.deformEditorSkinVertices(skinEntity, {
  vertices: [{ x: 2, y: 3, weights: [{ boneId: 'bone', weight: 1 }] }]
}, {
  objects: [skinEntity, { id: 'bone' }],
  matrices: new Map([['skin', identity], ['bone', [1, 0, 0, 1, 10, 0]]]),
  baseMatrices: new Map([['skin', identity], ['bone', identity]])
});
assert.deepEqual(JSON.parse(JSON.stringify(deformed)), [{ x: 12, y: 3 }], 'Skin preview must apply current Bone matrices relative to the bind pose');

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
