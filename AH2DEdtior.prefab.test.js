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

const editorFunctionSource = name => {
  const source = html.match(new RegExp(`function ${name}\\([^\\r\\n]+`))?.[0];
  assert.ok(source, `${name} must be extractable for executable regression testing`);
  return source;
};

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
