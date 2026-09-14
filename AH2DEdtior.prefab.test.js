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

const requiredLifecycle = [
  'list:', 'get:', 'createFromSelection:', 'instantiate:', 'setOverride:',
  'apply:', 'revert:', 'unpack:', 'open:'
];
const prefabApi = html.match(/prefabs:\s*\{([\s\S]*?)\n \}\n\};/)?.[1] || '';
for (const token of requiredLifecycle) {
  assert.ok(prefabApi.includes(token), `runtime Prefab API must expose ${token}`);
}

assert.match(html, /for\(const record of saved\)/, 'Apply must preserve overrides from sibling instances');
assert.match(html, /nodes\.some\(item=>prefabMarker\(item\)\)/, 'nested connected Prefabs must be guarded');
assert.match(html, /entityCodec\.remove\(entity,'PrefabInstance',\{allLocations:true\}\)/, 'Unpack must remove every Prefab marker projection');
assert.match(html, /canonicalizePrefabOverrides/, 'override operations must be canonicalized against the Asset');
assert.match(html, /applyPrefabOverrideOperation\(entity,path,operation\)/, 'Editor must use the controlled whole-component Prefab override helper');
assert.match(html, /currentPrefabInstanceGroup/, 'stale Prefab groups must be kept separate from current Asset synchronization');
assert.match(html, /clearEditorTransformLocations/, 'root placement comparison must not remove the required Transform through EntityCodec');
assert.match(html, /prefabOverridePathAllowed/, 'structural override paths must be rejected');
assert.doesNotMatch(html, /overrides\[[^\]]+\].*\/parentId/, 'parentId must never be authored as an override');
assert.doesNotMatch(html, /['"]\$(?:added|entities)['"]/, 'structural pseudo-overrides must not be serialized');
assert.match(html, /readEditorComponent\(entity,'Renderable'\)/, 'component-only Renderable data must be projected for the Editor');
assert.match(html, /prefabRevision:revision/, 'instances must track the canonical Asset revision');
assert.match(html, /revision:Number\.isInteger\(prefab\.revision\)/, 'Prefab Assets must serialize canonical revision');
assert.match(html, /assertPrefabDocument\(document/, 'save/export must validate the connected Prefab graph');
assert.match(html, /sourceMap=new Map\(nodes\.map\(item=>\[item\.id,item\.id\]\)\)/, 'Prefab source IDs must preserve authored Entity IDs so Animation track targets remap per instance');
assert.doesNotMatch(html, /sourceMap=new Map\(nodes\.map\(item=>\[item\.id,uniqueEditorId/, 'Prefab creation must not orphan Animation track target IDs by randomizing source IDs');
assert.match(html, /return remapRigEntityReferences\(copy,idMap\)/, 'standalone subtree duplication must remap internal rig references');
assert.match(html, /function instantiatePrefab[^\r\n]+return copy/, 'Prefab instantiation must preserve canonical Asset component data');
assert.match(html, /function canRemoveRigEntities/, 'destructive hierarchy actions must guard Skeleton ancestry');
assert.match(html, /try\{assertEditorRigScope\(objects\)\}catch/, 'reparenting must transactionally reject invalid rig topology');
assert.match(html, /repairRigReferencesAfterEntityRemoval\(objects,removalIds\)/, 'context-menu removal must repair rig references before rendering');
assert.match(html, /target=targetEntity\?rigStoredEntityId\(owner\|\|targetEntity,targetEntity\)/, 'Animation tracks on connected Prefabs must retain source IDs from their exact owner group');
assert.match(html, /candidate\?\.prefabId===marker\.prefabId&&candidate\.instanceRootId===marker\.instanceRootId/, 'rig resolution must use the exact Prefab and instance group');
assert.match(html, /catch\{const createdIds=new Set/, 'invalid duplicated or pasted rig subtrees must be removed transactionally');
assert.match(html, /const detached=detachCopiedAnimationBindings\(created,idMap\)/, 'standalone subtree duplication must detach affected Animation Clips');
assert.match(html, /assertEditorRigScope\(objects\);assertEditorAnimationScope\(objects\)/, 'standalone subtree duplication must validate rig and Animation target scope together');
assert.match(html, /state\.animations=animationsBefore;state\.assets=assetsBefore/, 'failed subtree duplication must roll back cloned Animation Clips and Assets');
assert.match(html, /prefab:preserveLoadedLegacyPrefab\?prepareEditorEntities\(base\.prefab\)/, 'legacy Prefab mirrors must be authoring-normalized before save');

const editorFunctionSource = name => {
  const source = html.match(new RegExp(`function ${name}\\([^\\r\\n]+`))?.[0];
  assert.ok(source, `${name} must be extractable for executable regression testing`);
  return source;
};

const instantiateSource = editorFunctionSource('instantiatePrefab');
assert.equal(instantiateSource.includes('remapRigEntityReferences'), false, 'expanded connected Prefabs must keep rig references in canonical source-ID space');
const unpackSource = editorFunctionSource('unpackPrefabInstance');
assert.ok(unpackSource.includes('sourceToConcrete=new Map'), 'Unpack must create a source-to-concrete map for its own instance');
assert.ok(unpackSource.indexOf('remapRigEntityReferences') < unpackSource.indexOf('removePrefabMarker'), 'Unpack must concretize rig references before removing connected Prefab identity');
assert.ok(unpackSource.indexOf('detachUnpackedAnimationBindings') < unpackSource.indexOf('removePrefabMarker'), 'Unpack must detach and retarget bound Animation Clips before removing connected Prefab identity');
assert.ok(unpackSource.includes('assertEditorAnimationScope(objects)'), 'Unpack must transactionally validate remapped Animation bindings');
const defaultKeySource = editorFunctionSource('defaultAnimationKeyValue');
assert.ok(defaultKeySource.includes('animationRigTargetEntity(targetId,animationRigOwner(clip))'), 'Bone/IK default keys must read the target from the exact connected instance');
const timelineSource = editorFunctionSource('renderTimeline');
assert.ok(timelineSource.includes('target=animationRigTargetEntity(reference,owner)'), 'every Timeline target label must resolve inside the exact connected instance');
const poseSource = editorFunctionSource('buildEditorSkeletonPose');
assert.ok(poseSource.includes('const sampledEntity=animationRigTargetEntity(sampled.targetEntityId,owner)'), 'Animator pose sampling must isolate every target type to the selected connected instance');
assert.equal(poseSource.includes('sampledEntity?.id||sampled.targetEntityId'), false, 'an unresolved connected Bone/IK track must not fall back to an arbitrary concrete Entity ID');

const unpackAnimationContext = vm.createContext({ cloneData: value => JSON.parse(JSON.stringify(value)) });
new vm.Script(editorFunctionSource('remapAnimationClipTargets')).runInContext(unpackAnimationContext);
const sharedClip = {
  id: 'walk', name: 'Walk', targetEntityId: 'source-rig', extension: { preserved: true },
  tracks: [
    { id: 'move', type: 'position', targetEntityId: 'source-rig', keyframes: [] },
    { id: 'bone', type: 'bone', targetEntityId: 'source-bone', keyframes: [] },
    { id: 'event', type: 'event', keyframes: [] }
  ]
};
const remappedClip = unpackAnimationContext.remapAnimationClipTargets(sharedClip, new Map([
  ['source-rig', 'instance-rig-b'], ['source-bone', 'instance-bone-b']
]));
assert.equal(remappedClip.changed, true, 'Unpack must detect source targets that require a private Clip');
assert.equal(remappedClip.clip.targetEntityId, 'instance-rig-b', 'Unpack must concretize Clip targets');
assert.equal(remappedClip.clip.tracks[1].targetEntityId, 'instance-bone-b', 'Unpack must concretize Bone/IK track targets');
assert.deepEqual(remappedClip.clip.extension, { preserved: true }, 'Unpack must preserve unknown Animation Clip data');
assert.equal(sharedClip.targetEntityId, 'source-rig', 'Unpack must not mutate a shared source Clip');
unpackAnimationContext.state = { animations: [sharedClip] };
unpackAnimationContext.readEditorComponent = (entity, type) => entity?.components?.[type] || null;
unpackAnimationContext.writeEditorComponent = (entity, type, value) => ((entity.components ||= {})[type] = value);
unpackAnimationContext.uniqueAnimationId = () => 'walk-unpacked';
new vm.Script(`${editorFunctionSource('editorAnimationClipForBinding')};${editorFunctionSource('uniqueUnpackedAnimationName')};${editorFunctionSource('detachUnpackedAnimationBindings')}`).runInContext(unpackAnimationContext);
const unpackedMember = { id: 'instance-rig-b', components: { Animation: { clipId: 'walk', autoplay: true } } };
const detachResult = unpackAnimationContext.detachUnpackedAnimationBindings([unpackedMember], new Map([
  ['source-rig', 'instance-rig-b'], ['source-bone', 'instance-bone-b']
]));
assert.deepEqual(JSON.parse(JSON.stringify(detachResult)), { clips: 1, bindings: 1 }, 'Unpack must create one private concrete-target Clip for a shared source Clip');
assert.equal(unpackedMember.components.Animation.clipId, 'walk-unpacked', 'the unpacked binding must switch to its private remapped Clip');
assert.equal(unpackAnimationContext.state.animations.length, 2, 'the shared source Clip must remain available to connected sibling instances');
assert.equal(unpackAnimationContext.state.animations[0].targetEntityId, 'source-rig', 'connected sibling instances must retain source-ID targets');

const copyAnimationContext = vm.createContext({
  cloneData: value => JSON.parse(JSON.stringify(value)),
  state: { animations: [sharedClip] },
  readEditorComponent: (entity, type) => entity?.components?.[type] || null,
  writeEditorComponent: (entity, type, value) => ((entity.components ||= {})[type] = value),
  uniqueAnimationId: () => 'walk-copy'
});
new vm.Script(`${editorFunctionSource('remapAnimationClipTargets')};${editorFunctionSource('editorAnimationClipForBinding')};${editorFunctionSource('uniqueCopiedAnimationName')};${editorFunctionSource('detachCopiedAnimationBindings')}`).runInContext(copyAnimationContext);
const copiedMembers = [
  { id: 'copy-rig', components: { Animation: { clipId: 'walk', autoplay: true } } },
  { id: 'copy-bone', components: { Animation: { clip: 'Walk', speed: 2 } } }
];
const copyResult = copyAnimationContext.detachCopiedAnimationBindings(copiedMembers, new Map([
  ['source-rig', 'copy-rig'], ['source-bone', 'copy-bone']
]));
assert.deepEqual(JSON.parse(JSON.stringify(copyResult)), { clips: 1, bindings: 2 }, 'Duplicate/Paste must create one private Clip per affected shared binding');
assert.equal(copiedMembers[0].components.Animation.clipId, 'walk-copy', 'a copied stable binding must switch to the private Clip');
assert.equal(copiedMembers[1].components.Animation.clipId, 'walk-copy', 'copied legacy bindings to the same Clip must share its private clone');
assert.equal('clip' in copiedMembers[1].components.Animation, false, 'a copied legacy binding must be upgraded without retaining an ambiguous name binding');
assert.equal(copyAnimationContext.state.animations.length, 2, 'Duplicate/Paste must retain the original shared Clip');
assert.equal(copyAnimationContext.state.animations[0].targetEntityId, 'source-rig', 'Duplicate/Paste must not mutate original Clip targets');
assert.equal(copyAnimationContext.state.animations[1].targetEntityId, 'copy-rig', 'the copied Clip root target must point into the new subtree');
assert.equal(copyAnimationContext.state.animations[1].tracks[1].targetEntityId, 'copy-bone', 'the copied Bone/IK track target must point into the new subtree');
assert.deepEqual(copyAnimationContext.state.animations[1].extension, { preserved: true }, 'the copied Clip must preserve unknown data');
const externalClip = { id: 'external', name: 'External', targetEntityId: 'outside', tracks: [{ id: 'external-position', type: 'position', targetEntityId: 'outside', keyframes: [] }] };
copyAnimationContext.state.animations.push(externalClip);
const unaffectedMember = { id: 'copy-static', components: { Animation: { clipId: 'external', autoplay: true } } };
assert.deepEqual(JSON.parse(JSON.stringify(copyAnimationContext.detachCopiedAnimationBindings([unaffectedMember], new Map([['source-rig', 'copy-static']])))), { clips: 0, bindings: 0 }, 'Duplicate/Paste must not clone a Clip whose targets are outside the copied subtree');
assert.equal(unaffectedMember.components.Animation.clipId, 'external', 'an unaffected copied binding must continue sharing its original Clip');
assert.equal(copyAnimationContext.state.animations.length, 3, 'an unaffected Clip must not create an extra Animation asset candidate');

const prefabRigContext = vm.createContext({
  prefabMarker: entity => entity?.marker || null,
  readEditorComponent: (entity, type) => entity?.components?.[type] || null
});
new vm.Script(`${editorFunctionSource('rigReferenceEntity')};${editorFunctionSource('rigStoredEntityId')};${editorFunctionSource('skeletonRootBone')};${editorFunctionSource('skeletonBoneChain')}`).runInContext(prefabRigContext);
const prefabRigObjects = [
  { id: 'source-rig', marker: { prefabId: 'fighter', instanceRootId: 'source-rig', sourceEntityId: 'source-rig' } },
  { id: 'source-bone', marker: { prefabId: 'fighter', instanceRootId: 'source-rig', sourceEntityId: 'source-bone' } },
  { id: 'instance-rig-b', marker: { prefabId: 'fighter', instanceRootId: 'instance-rig-b', sourceEntityId: 'source-rig' } },
  { id: 'instance-bone-b', marker: { prefabId: 'fighter', instanceRootId: 'instance-rig-b', sourceEntityId: 'source-bone' } },
  { id: 'collision-id', parentId: 'instance-rig-b', components: { Bone: { length: 1 } } },
  { id: 'foreign-bone', marker: { prefabId: 'enemy', instanceRootId: 'instance-rig-b', sourceEntityId: 'foreign-source' } }
];
assert.equal(prefabRigContext.rigReferenceEntity(prefabRigObjects, prefabRigObjects[2], 'source-bone').id, 'instance-bone-b', 'a source-ID rig reference must resolve inside its exact owning connected instance');
assert.equal(prefabRigContext.rigReferenceEntity(prefabRigObjects, prefabRigObjects[2], 'collision-id'), null, 'a marked owner must not fall back to an unrelated Entity whose concrete ID collides with a missing source ID');
assert.equal(prefabRigContext.rigReferenceEntity(prefabRigObjects, prefabRigObjects[2], 'foreign-source'), null, 'a marked owner must not resolve a matching source ID from another Prefab sharing a malformed instanceRootId');
assert.equal(prefabRigContext.rigReferenceEntity(prefabRigObjects, prefabRigObjects[4], 'collision-id').id, 'collision-id', 'ordinary unmarked rig references retain direct-ID resolution');
assert.equal(prefabRigContext.rigStoredEntityId(prefabRigObjects[2], prefabRigObjects[3]), 'source-bone', 'connected instance authoring must retain canonical source IDs');
assert.equal(prefabRigContext.rigStoredEntityId(prefabRigObjects[2], prefabRigObjects[5]), 'foreign-bone', 'source IDs must not be stored across different Prefab groups');
assert.deepEqual(Array.from(prefabRigContext.skeletonBoneChain(prefabRigObjects, 'source-rig', 'collision-id', prefabRigObjects[2])), [], 'IK chain authoring must not fall back to a colliding concrete Entity ID outside source-ID resolution');
const compactRig = [
  { id: 'compact', components: { Skeleton: {}, Bone: { length: 12 } } },
  { id: 'tip', parentId: 'compact', components: { Bone: { length: 8 } } }
];
assert.equal(prefabRigContext.skeletonRootBone(compactRig, compactRig[0]).id, 'compact', 'a co-located Skeleton+Bone Entity is its own implicit root Bone');
assert.deepEqual(Array.from(prefabRigContext.skeletonBoneChain(compactRig, 'compact', 'tip', compactRig[0])), ['compact', 'tip'], 'IK chain authoring must include a co-located root Bone');
assert.ok(editorFunctionSource('addBoneToSkeleton').includes('!skeleton.rootBoneId&&!rootIsBone'), 'adding a child to an implicit co-located root must not author a duplicate rootBoneId');
assert.ok(editorFunctionSource('createSkeletonRig').includes('const rootBone=skeletonRootBone(objects,root)'), 'Skeleton creation must reuse a co-located Bone as its root');
assert.ok(editorFunctionSource('addIKTargetToSkeleton').includes('rootBone=skeletonRootBone(objects,root)'), 'IK creation must resolve implicit co-located root Bones');

const animationRigContext = vm.createContext({
  state: { scene: prefabRigObjects },
  prefabMarker: entity => entity?.marker || null,
  animationEntityById: id => prefabRigObjects.find(entity => entity.id === id) || null,
  animationRigOwner: () => prefabRigObjects[2],
  animationTrack: () => null,
  animationPreviewTargetId: () => null
});
new vm.Script(`${editorFunctionSource('rigReferenceEntity')};${editorFunctionSource('animationRigTargetEntity')};${editorFunctionSource('animationTarget')}`).runInContext(animationRigContext);
assert.equal(animationRigContext.animationRigTargetEntity('source-bone', prefabRigObjects[2]).id, 'instance-bone-b', 'Bone/IK target lookup must resolve canonical source IDs inside the selected instance');
assert.equal(animationRigContext.animationRigTargetEntity('instance-bone-b', prefabRigObjects[2]).id, 'instance-bone-b', 'an explicitly selected concrete Bone in the same instance remains valid');
assert.equal(animationRigContext.animationRigTargetEntity('collision-id', prefabRigObjects[2]), null, 'Bone/IK target lookup must not escape to an unrelated concrete-ID collision');
assert.equal(animationRigContext.animationTarget({ tracks: [] }, 'sprite', 'source-bone').id, 'instance-bone-b', 'ordinary preview tracks must use the same exact Prefab instance resolution as Bone/IK tracks');
assert.equal(animationRigContext.animationTarget({ tracks: [] }, 'position', 'collision-id'), null, 'ordinary preview tracks must not escape to an unrelated concrete-ID collision');

const rigRemovalContext = vm.createContext({
  readEditorComponent: (entity, type) => entity?.components?.[type] || null,
  skeletonRootForEntity: (objects, entity) => objects.find(item => item.id === entity?.rootId) || null,
  rigReferenceEntity: (objects, owner, id) => objects.find(item => item.id === id) || null
});
new vm.Script(editorFunctionSource('canRemoveRigEntities')).runInContext(rigRemovalContext);
const rigObjects = [
  { id: 'rig', components: { Skeleton: { rootBoneId: 'hip' } }, rootId: 'rig' },
  { id: 'hip', parentId: 'rig', components: { Bone: { length: 20 } }, rootId: 'rig' },
  { id: 'left', parentId: 'hip', components: { Bone: { length: 10 } }, rootId: 'rig' },
  { id: 'right', parentId: 'hip', components: { Bone: { length: 10 } }, rootId: 'rig' }
];
assert.equal(rigRemovalContext.canRemoveRigEntities(rigObjects, ['rig']), false, 'removing a Skeleton while its Bone hierarchy survives must be rejected');
assert.equal(rigRemovalContext.canRemoveRigEntities(rigObjects, ['hip']), false, 'removing a root Bone with multiple surviving roots must be rejected');
assert.equal(rigRemovalContext.canRemoveRigEntities(rigObjects, rigObjects.map(item => item.id)), true, 'removing a complete rig hierarchy may proceed atomically');

const removalState = {
  scene: [],
  scenes: [{ id: 'main', objects: [{ id: 'actor-body' }] }],
  currentSceneId: 'main',
  prefab: [],
  prefabs: [{ id: 'actor-prefab', entities: [{ id: 'actor-body' }] }],
  activePrefabId: null,
  animations: [{
    id: 'actor-motion',
    targetEntityId: 'actor-body',
    tracks: [{ id: 'body-position', type: 'position', targetEntityId: 'actor-body', keyframes: [] }]
  }]
};
const removalContext = vm.createContext({ state: removalState });
new vm.Script(`${editorFunctionSource('animationTargetStillExists')};${editorFunctionSource('repairAnimationTargetsAfterEntityRemoval')}`).runInContext(removalContext);
assert.equal(removalContext.repairAnimationTargetsAfterEntityRemoval(['actor-body']), 0, 'removing the first linked instance must retain targets backed by the Prefab source');
assert.equal(removalState.animations[0].targetEntityId, 'actor-body');
assert.equal(removalState.animations[0].tracks[0].targetEntityId, 'actor-body');
removalState.prefabs = [];
assert.equal(removalContext.repairAnimationTargetsAfterEntityRemoval(['actor-body']), 2, 'targets must clear after their last live Scene or Prefab source is removed');
assert.equal('targetEntityId' in removalState.animations[0], false);
assert.equal('targetEntityId' in removalState.animations[0].tracks[0], false);

console.log(`AH2DEdtior Prefab regression checks passed (${scripts.length} inline scripts parsed)`);
