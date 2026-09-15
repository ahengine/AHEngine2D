'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DataModel = require('./AH2DDataModel.js');

const {
  DATA_MODEL_ID,
  DATA_MODEL_VERSION,
  COMPONENT_SCHEMA_VERSION,
  ComponentSchemaError,
  ComponentSchemaRegistry,
  createDefaultComponentRegistry,
  createDefaultEntityCodec,
  COMPONENT_SCHEMAS,
  COMPONENT_MAP_SCHEMA,
  ENTITY_SCHEMA,
  JSON_SCHEMAS,
  PREFAB_ASSET_SCHEMA,
  PREFAB_OVERRIDE_OPERATIONS,
  parseJsonPointer,
  prefabOverridePathAllowed,
  prefabRootPlacementPath,
  jsonPointerLookup,
  applyJsonPointerOperation,
  applyPrefabOverrideOperation,
  validatePrefabDocument,
  assertPrefabDocument,
  ANIMATION_CLIP_SCHEMA,
  normalizeAnimationClip,
  normalizeAnimationClips,
  sampleAnimationClip,
  validateAnimationDocument,
  assertAnimationDocument,
  validateSkeletonDocument,
  assertSkeletonDocument,
  PARTICLE_ASSET_SCHEMA,
  PARTICLE_CURVE_SCHEMA,
  PARTICLE_CURVE_KEY_SCHEMA,
  PARTICLE_CURVE_PROPERTIES,
  PARTICLE_CURVE_INTERPOLATIONS,
  normalizeParticleAsset,
  normalizeParticleAssets,
  sampleParticleCurve,
  validateParticleDocument,
  assertParticleDocument,
  SHADER_NODE_TYPES,
  SHADER_NODE_DEFINITIONS,
  SHADER_HEX_COLOR_PATTERN,
  SHADER_GRAPH_DEFAULTS,
  SHADER_GRAPH_SCHEMA,
  POST_PROCESS_EFFECT_SCHEMA,
  POST_PROCESS_SCHEMA,
  normalizeShaderGraph,
  normalizeShaderGraphs,
  validateShaderGraphDocument,
  assertShaderGraphDocument
} = DataModel;

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('exports stable constants, schemas, and a browser global', () => {
  assert.strictEqual(DATA_MODEL_ID, 'ah2d.ecs');
  assert.strictEqual(DATA_MODEL_VERSION, 1);
  assert.strictEqual(COMPONENT_SCHEMA_VERSION, 1);
  assert.strictEqual(ENTITY_SCHEMA.$id, 'ah2d.ecs/entity/1');
  assert.strictEqual(COMPONENT_MAP_SCHEMA.type, 'object');
  assert.deepStrictEqual(COMPONENT_MAP_SCHEMA.properties.RigidBody, COMPONENT_MAP_SCHEMA.properties.Rigidbody);
  assert.deepStrictEqual(COMPONENT_MAP_SCHEMA.properties.Body, COMPONENT_MAP_SCHEMA.properties.Rigidbody);
  assert.strictEqual(ENTITY_SCHEMA.properties.id.pattern, '\\S');
  assert.strictEqual(JSON_SCHEMAS.components, COMPONENT_SCHEMAS);
  assert.strictEqual(JSON_SCHEMAS.prefabAsset, PREFAB_ASSET_SCHEMA);
  assert.strictEqual(JSON_SCHEMAS.particleAsset, PARTICLE_ASSET_SCHEMA);
  assert.strictEqual(JSON_SCHEMAS.shaderGraph, SHADER_GRAPH_SCHEMA);
  assert.strictEqual(JSON_SCHEMAS.postProcessEffect, POST_PROCESS_EFFECT_SCHEMA);
  assert.strictEqual(JSON_SCHEMAS.postProcess, POST_PROCESS_SCHEMA);
  assert.deepStrictEqual(PREFAB_OVERRIDE_OPERATIONS, ['add', 'replace', 'remove']);

  const source = fs.readFileSync(path.join(__dirname, 'AH2DDataModel.js'), 'utf8');
  const browser = {};
  vm.runInNewContext(source, browser, { filename: 'AH2DDataModel.js' });
  assert.strictEqual(browser.AH2DDataModel.DATA_MODEL_ID, 'ah2d.ecs');
  assert.strictEqual(typeof browser.AH2DDataModel.createDefaultEntityCodec, 'function');
  assert.strictEqual(typeof browser.AH2DDataModel.validatePrefabDocument, 'function');
  assert.strictEqual(typeof browser.AH2DDataModel.validateSkeletonDocument, 'function');
  assert.strictEqual(typeof browser.AH2DDataModel.sampleParticleCurve, 'function');
  assert.strictEqual(typeof browser.AH2DDataModel.normalizeShaderGraph, 'function');
  assert.strictEqual(typeof browser.AH2DDataModel.validateShaderGraphDocument, 'function');
});

test('applies canonical Prefab override pointers safely and protects instance identity', () => {
  const value = { name: 'Knight', metadata: { 'a/b': { '~key': 1 } }, tags: ['player'] };
  assert.deepStrictEqual(parseJsonPointer('/metadata/a~1b/~0key'), ['metadata', 'a/b', '~key']);
  assert.deepStrictEqual(jsonPointerLookup(value, '/metadata/a~1b/~0key'), {
    found: true, value: 1, parent: value.metadata['a/b'], key: '~key'
  });
  applyJsonPointerOperation(value, '/metadata/a~1b/~0key', { op: 'replace', value: 2 });
  applyJsonPointerOperation(value, '/tags/1', { op: 'add', value: 'hero' });
  applyJsonPointerOperation(value, '/name', { op: 'remove' });
  assert.deepStrictEqual(value, { metadata: { 'a/b': { '~key': 2 } }, tags: ['player', 'hero'] });
  assert.strictEqual(prefabOverridePathAllowed('/components/Renderable/color'), true);
  assert.strictEqual(prefabOverridePathAllowed('/parentId'), false);
  assert.strictEqual(prefabOverridePathAllowed('/components/PrefabInstance/prefabId'), false);
  assert.strictEqual(prefabOverridePathAllowed('/tags/-', { target: value }), false);
  assert.strictEqual(prefabOverridePathAllowed('/metadata/-', { target: value }), true);
  applyJsonPointerOperation(value, '/metadata/-', { op: 'add', value: 3 });
  assert.strictEqual(value.metadata['-'], 3, '`-` is a durable object-member name under RFC 6901');
  assert.throws(() => applyJsonPointerOperation(value, '/tags/-', { op: 'add', value: 'mage' }), error => error.code === 'E_PREFAB_OVERRIDE_PROTECTED');
  assert.strictEqual(prefabRootPlacementPath('/components/Transform/x'), true);
  assert.strictEqual(prefabRootPlacementPath('/components/Renderable/color'), false);
  assert.throws(() => applyJsonPointerOperation(value, '/id', { op: 'add', value: 'other' }), error => error.code === 'E_PREFAB_OVERRIDE_PROTECTED');
  assert.throws(() => parseJsonPointer('/unsafe/~2'), error => error.code === 'E_PREFAB_OVERRIDE_PATH');
  assert.throws(() => applyJsonPointerOperation(value, '/metadata/missing/value', { op: 'add', value: 1 }), error => error.code === 'E_PREFAB_OVERRIDE_TARGET');
  const compactSource = { id: 'compact' };
  applyPrefabOverrideOperation(compactSource, '/components/Health', { op: 'add', value: { current: 5 } });
  assert.deepStrictEqual(compactSource.components.Health, { current: 5 });
  const invalidCompactSource = { id: 'invalid-compact' };
  assert.throws(() => applyPrefabOverrideOperation(invalidCompactSource, '/components/Health', { op: 'add' }), error => error.code === 'E_PREFAB_OVERRIDE_VALUE');
  assert.deepStrictEqual(invalidCompactSource, { id: 'invalid-compact' }, 'a rejected whole-Component add must not synthesize partial state');
  assert.throws(() => applyPrefabOverrideOperation({ id: 'compact' }, '/components/Health/current', { op: 'add', value: 5 }), error => error.code === 'E_PREFAB_OVERRIDE_TARGET');
});

test('validates Prefab Assets and complete expanded instance membership without mutating unknown data', () => {
  const project = {
    format: 'AH2D', version: 4,
    prefabs: [{
      id: 'knight', name: 'Knight', rootEntityId: 'body', revision: 3, futureAsset: { keep: true },
      entities: [
        { id: 'body', name: 'Body', parentId: null, x: 0, y: 0, futureEntity: 1 },
        { id: 'weapon', name: 'Weapon', parentId: 'body', x: 10, y: 0, components: { Renderable: { color: '#fff', futureRender: true } } }
      ]
    }],
    currentSceneId: 'main',
    scenes: [{ id: 'main', objects: [
      { id: 'holder', name: 'Holder' },
      { id: 'knight-1', name: 'Body', parentId: 'holder', x: 40, y: 50, futureEntity: 1, components: { PrefabInstance: {
        prefabId: 'knight', sourceEntityId: 'body', instanceRootId: 'knight-1', prefabRevision: 3, overrides: {}, futureMarker: true
      } } },
      { id: 'weapon-1', name: 'Sword', parentId: 'knight-1', x: 10, y: 0, components: {
        Renderable: { color: '#f00', futureRender: true },
        PrefabInstance: {
          prefabId: 'knight', sourceEntityId: 'weapon', instanceRootId: 'knight-1', prefabRevision: 3,
          overrides: { '/name': { op: 'replace', value: 'Sword' }, '/components/Renderable/color': { op: 'replace', value: '#f00' } }
        }
      } }
    ] }]
  };
  project.scene = JSON.parse(JSON.stringify(project.scenes[0].objects));
  const before = JSON.stringify(project);
  assert.deepStrictEqual(validatePrefabDocument(project), []);
  assert.deepStrictEqual(assertPrefabDocument(project), []);
  assert.strictEqual(JSON.stringify(project), before, 'Prefab validation must be non-mutating');
  assert.strictEqual(project.prefabs[0].futureAsset.keep, true);
  assert.strictEqual(project.scenes[0].objects[1].components.PrefabInstance.futureMarker, true);

  const caseVariantPlacement = JSON.parse(JSON.stringify(project));
  for (const entity of [caseVariantPlacement.prefabs[0].entities[0], caseVariantPlacement.scenes[0].objects[1]]) {
    for (const key of ['x', 'y', 'rot', 'rotation', 'sx', 'sy', 'scaleX', 'scaleY']) delete entity[key];
  }
  caseVariantPlacement.prefabs[0].entities[0].components = { TRANSFORM: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } };
  caseVariantPlacement.scenes[0].objects[1].components.TRANSFORM = { x: 90, y: 40, rotation: 12, scaleX: 2, scaleY: 2 };
  assert.strictEqual(validatePrefabDocument(caseVariantPlacement).some(item => item.code === 'E_PREFAB_INSTANCE_STATE'), false, 'root placement must ignore every valid Transform storage spelling');

  const mixedRevision = JSON.parse(JSON.stringify(project));
  mixedRevision.scenes[0].objects[2].components.PrefabInstance.prefabRevision = 0;
  assert(validatePrefabDocument(mixedRevision).some(item => item.code === 'E_PREFAB_INSTANCE_REVISION_MISMATCH'));

  const missingRevision = JSON.parse(JSON.stringify(project));
  delete missingRevision.scenes[0].objects[1].components.PrefabInstance.prefabRevision;
  delete missingRevision.scenes[0].objects[2].components.PrefabInstance.prefabRevision;
  assert(validatePrefabDocument(missingRevision).some(item => item.code === 'E_PREFAB_INSTANCE_REVISION'));

  const stale = JSON.parse(JSON.stringify(project));
  stale.scenes[0].objects[1].components.PrefabInstance.prefabRevision = 2;
  assert(validatePrefabDocument(stale).some(item => item.code === 'W_PREFAB_INSTANCE_STALE' && item.severity === 'warning'));

  const staleRemovedSource = JSON.parse(JSON.stringify(project));
  staleRemovedSource.prefabs[0].revision = 4;
  delete staleRemovedSource.prefabs[0].entities[1].components.Renderable.color;
  for (const entity of staleRemovedSource.scenes[0].objects) {
    if (entity.components?.PrefabInstance) entity.components.PrefabInstance.prefabRevision = 3;
  }
  assert.strictEqual(validatePrefabDocument(staleRemovedSource).some(item => item.code === 'E_PREFAB_OVERRIDE_SOURCE'), false, 'stale replace/remove records cannot be judged against a newer Asset source');

  const staleAddedSource = JSON.parse(JSON.stringify(project));
  staleAddedSource.prefabs[0].revision = 4;
  staleAddedSource.prefabs[0].entities[1].futureAdded = 'asset-now-owns-path';
  staleAddedSource.scenes[0].objects[2].futureAdded = 'local-value';
  staleAddedSource.scenes[0].objects[2].components.PrefabInstance.overrides['/futureAdded'] = { op: 'add', value: 'local-value' };
  for (const entity of staleAddedSource.scenes[0].objects) {
    if (entity.components?.PrefabInstance) entity.components.PrefabInstance.prefabRevision = 3;
  }
  assert.strictEqual(validatePrefabDocument(staleAddedSource).some(item => item.code === 'E_PREFAB_OVERRIDE_SOURCE'), false, 'stale add records must remain loadable after the Asset starts owning their path');

  const overlapping = JSON.parse(JSON.stringify(project));
  overlapping.scenes[0].objects[2].components.PrefabInstance.overrides['/components/Renderable'] = {
    op: 'replace', value: { color: '#f00' }
  };
  assert(validatePrefabDocument(overlapping).some(item => item.code === 'E_PREFAB_OVERRIDE_CONFLICT'));

  const missingParent = JSON.parse(JSON.stringify(project));
  missingParent.scenes[0].objects[2].components.PrefabInstance.overrides['/components/Missing/value'] = { op: 'add', value: 1 };
  assert(validatePrefabDocument(missingParent).some(item => item.code === 'E_PREFAB_OVERRIDE_TARGET'));

  const sequentialArrayAdds = JSON.parse(JSON.stringify(project));
  sequentialArrayAdds.prefabs[0].entities[1].values = ['a', 'b'];
  sequentialArrayAdds.scenes[0].objects[2].values = ['a', 'b', 'c', 'd'];
  sequentialArrayAdds.scenes[0].objects[2].components.PrefabInstance.overrides = {
    '/values/2': { op: 'add', value: 'c' },
    '/values/3': { op: 'add', value: 'd' }
  };
  assert.strictEqual(validatePrefabDocument(sequentialArrayAdds).some(item => item.code === 'E_PREFAB_OVERRIDE_TARGET'), false, 'ordered array appends must validate against one projected instance state');

  const untracked = JSON.parse(JSON.stringify(project));
  untracked.scenes[0].objects[2].components.Renderable.color = '#123456';
  assert(validatePrefabDocument(untracked).some(item => item.code === 'E_PREFAB_INSTANCE_STATE'));

  const structuralChild = JSON.parse(JSON.stringify(project));
  structuralChild.scenes[0].objects.push({ id: 'extra-child', name: 'Extra', parentId: 'weapon-1' });
  assert(validatePrefabDocument(structuralChild).some(item => item.code === 'E_PREFAB_STRUCTURAL_EDIT'));

  const legacy = JSON.parse(JSON.stringify(project));
  legacy.scenes[0].objects.push({ id: 'legacy-prefab', components: { PrefabInstance: { prefabId: 'old-workspace', overrides: { tint: 'blue' } } } });
  assert.strictEqual(validatePrefabDocument(legacy).some(item => item.severity === 'error'), false, 'prefabId-only legacy markers remain opaque');
});

test('reports malformed Prefab graphs, dangling instance links, invalid operations, and root placement overrides', () => {
  const base = {
    format: 'AH2D', version: 4,
    prefabs: [{ id: 'p', rootEntityId: 'root', revision: 1, entities: [
      { id: 'root', name: 'Root', parentId: null },
      { id: 'child', name: 'Child', parentId: 'root' }
    ] }],
    currentSceneId: 'main',
    scenes: [{ id: 'main', objects: [
      { id: 'instance', parentId: null, components: { PrefabInstance: {
        prefabId: 'p', sourceEntityId: 'root', instanceRootId: 'instance', prefabRevision: 1,
        overrides: { '/x': { op: 'replace', value: 4 } }
      } } },
      { id: 'instance-child', parentId: 'wrong-parent', components: { PrefabInstance: {
        prefabId: 'p', sourceEntityId: 'missing-source', instanceRootId: 'instance', prefabRevision: 1,
        overrides: { '/parentId': { op: 'replace', value: null }, 'not-a-pointer': { op: 'replace', value: 1 } }
      } } }
    ] }]
  };
  const codes = new Set(validatePrefabDocument(base).map(item => item.code));
  for (const code of ['E_PREFAB_PLACEMENT_PATH', 'E_PREFAB_INSTANCE_SOURCE_MISSING', 'E_PREFAB_INSTANCE_MEMBER_MISSING', 'E_PREFAB_OVERRIDE_PROTECTED', 'E_PREFAB_OVERRIDE_PATH']) {
    assert(codes.has(code), `${code} was not reported`);
  }

  const brokenAsset = JSON.parse(JSON.stringify(base));
  brokenAsset.scenes[0].objects = [];
  brokenAsset.prefabs[0].entities[0].parentId = 'child';
  assert(validatePrefabDocument(brokenAsset).some(item => item.code === 'E_PREFAB_ROOT_PARENT'));
  assert(validatePrefabDocument(brokenAsset).some(item => item.code === 'E_PREFAB_PARENT_CYCLE'));

  const duplicate = JSON.parse(JSON.stringify(base));
  duplicate.scenes[0].objects = [];
  duplicate.prefabs.push(JSON.parse(JSON.stringify(duplicate.prefabs[0])));
  assert(validatePrefabDocument(duplicate).some(item => item.code === 'E_PREFAB_ID_DUPLICATE'));
  assert.throws(() => assertPrefabDocument(base), error => error instanceof ComponentSchemaError && error.diagnostics.some(item => item.code === 'E_PREFAB_PLACEMENT_PATH'));
});

test('registers every built-in with independent collider types and only Rigidbody aliases', () => {
  const registry = createDefaultComponentRegistry();
  const types = registry.list().map(item => item.type);
  for (const type of [
    'Name', 'Transform', 'Renderable', 'Rigidbody', 'Collider', 'Hidden', 'Locked', 'PrefabInstance',
    'Camera', 'Light', 'ShadowCaster', 'Animation', 'Skeleton', 'Bone', 'IK', 'Skin', 'Tilemap', 'ParticleEmitter',
    'BoxCollider', 'BoxCollider2D', 'CircleCollider', 'CircleCollider2D'
  ]) assert(types.includes(type), `missing ${type}`);

  assert.strictEqual(registry.resolve('RigidBody'), 'Rigidbody');
  assert.strictEqual(registry.resolve('Body'), 'Rigidbody');
  assert.deepStrictEqual(registry.describe('Rigidbody').aliases, ['RigidBody', 'Body']);
  assert.deepStrictEqual(registry.describe('Transform').profiles.authoring, registry.describe('Transform').schemas.authoring);
  for (const type of ['Collider', 'BoxCollider', 'BoxCollider2D', 'CircleCollider', 'CircleCollider2D']) {
    assert.strictEqual(registry.resolve(type), type);
    assert.deepStrictEqual(registry.describe(type).aliases, []);
  }
});

test('keeps public descriptors isolated while runtime decoding uses lightweight registry metadata', () => {
  const registry = createDefaultComponentRegistry();
  const described = registry.describe('Transform');
  const listed = registry.list();
  described.aliases.push('MutatedAlias');
  listed.find(item => item.type === 'Transform').storage.preferred = 'mutated';
  assert.deepStrictEqual(registry.describe('Transform').aliases, []);
  assert.strictEqual(registry.describe('Transform').storage.preferred, 'flat-transform');

  let publicListCalls = 0;
  let publicDescribeCalls = 0;
  const publicList = registry.list.bind(registry);
  const publicDescribe = registry.describe.bind(registry);
  registry.list = (...args) => { publicListCalls += 1; return publicList(...args); };
  registry.describe = (...args) => { publicDescribeCalls += 1; return publicDescribe(...args); };
  const codec = createDefaultEntityCodec({ registry });
  const count = 2000;
  const startedAt = Date.now();
  let decoded;
  for (let index = 0; index < count; index += 1) {
    decoded = codec.decodeToRuntime({
      id: `deep-${index}`,
      parentId: index === 0 ? null : `deep-${index - 1}`,
      x: 1,
      y: 0,
      components: { FutureData: { index, nested: { keep: true } } }
    });
  }
  const elapsed = Date.now() - startedAt;

  assert.strictEqual(publicListCalls, 0, 'runtime decoding must not clone the complete public registry list per Entity');
  assert.strictEqual(publicDescribeCalls, 0, 'runtime decoding must not clone public schema descriptors per Component');
  assert.strictEqual(decoded.parentId, 'deep-1998');
  assert.strictEqual(decoded.components.Transform.x, 1);
  assert.deepStrictEqual(decoded.components.FutureData, { index: 1999, nested: { keep: true } });
  assert.ok(elapsed < 5000, `decoding ${count} Entities took ${elapsed}ms; expected the lightweight metadata path to stay below 5000ms`);
});

test('rejects canonical and alias collisions without mutating the registry', () => {
  const registry = new ComponentSchemaRegistry();
  registry.register({ type: 'Motion', aliases: ['Mover'], schema: { type: 'object' } });
  assert.throws(
    () => registry.register({ type: 'Mover', schema: { type: 'object' } }),
    error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_ALIAS_COLLISION'
  );
  assert.throws(
    () => registry.register({ type: 'Other', aliases: ['Motion'], schema: { type: 'object' } }),
    error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_ALIAS_COLLISION'
  );
  assert.throws(
    () => registry.register({ type: 'Solo', aliases: ['Solo'], schema: { type: 'object' } }),
    error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_ALIAS_COLLISION'
  );
  assert.strictEqual(registry.resolve('Motion'), 'Motion');
  assert.strictEqual(registry.resolve('Mover'), 'Motion');
  assert.strictEqual(registry.resolve('Other'), 'Other');
  assert.strictEqual(registry.list().length, 1);
});

test('creates fresh defaults and preserves zero Transform scale', () => {
  const registry = createDefaultComponentRegistry();
  const first = registry.create('Rigidbody');
  const second = registry.create('Rigidbody');
  assert.deepStrictEqual(first, {
    enabled: true, type: 'dynamic', mass: 1, useAutoMass: false, gravityScale: 1,
    linearDamping: 0.08, angularDamping: 0.08, fixedRotation: false, bullet: false,
    allowSleep: true, sleeping: false, velocityX: 0, velocityY: 0, angularVelocity: 0
  });
  first.mass = 99;
  assert.strictEqual(second.mass, 1);

  assert.deepStrictEqual(registry.create('Transform', {}, { entity: { x: 2, sx: 0, sy: 0 } }), {
    x: 2, y: 0, rotation: 0, scaleX: 0, scaleY: 0
  });
  assert.deepStrictEqual(registry.create('Transform', { rot: 15, sx: 0, sy: 2 }), {
    x: 0, y: 0, rotation: 15, scaleX: 0, scaleY: 2, rot: 15, sx: 0, sy: 2
  });
  assert.deepStrictEqual(registry.normalize('Transform', { rot: 20, sx: 0 }, { applyDefaults: true }), {
    x: 0, y: 0, rotation: 20, scaleX: 0, scaleY: 1, rot: 20, sx: 0
  });
  const collider = registry.create('Collider', {}, { entity: { w: 80, h: 40 } });
  assert.strictEqual(collider.width, 80);
  assert.strictEqual(collider.height, 40);
  assert.strictEqual(collider.radius, 20);
});

test('normalization is sparse by default and preserves unknown fields', () => {
  const registry = createDefaultComponentRegistry();
  const source = { mass: 2, extension: { future: true } };
  const normalized = registry.normalize('Rigidbody', source);
  assert.deepStrictEqual(normalized, source);
  assert.notStrictEqual(normalized, source);
  assert.notStrictEqual(normalized.extension, source.extension);
  assert.strictEqual(normalized.enabled, undefined);

  const withDefaults = registry.normalize('Rigidbody', source, { applyDefaults: true });
  assert.strictEqual(withDefaults.enabled, true);
  assert.deepStrictEqual(withDefaults.extension, { future: true });

  const prototypeField = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
  const safeClone = registry.normalize('CustomData', prototypeField);
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(safeClone, '__proto__'), true);
  assert.deepStrictEqual(safeClone.__proto__, { polluted: true });
});

test('uses components.* precedence, reports conflicts, and preserves provenance on writes', () => {
  const codec = createDefaultEntityCodec();
  const entity = {
    id: 'player',
    rigidbody: { mass: 1, legacyOnly: true },
    components: { Rigidbody: { mass: 9, custom: 'kept' } }
  };
  const resolved = codec.resolve(entity, 'Body');
  assert.strictEqual(resolved.type, 'Rigidbody');
  assert.strictEqual(resolved.storage, 'components.Rigidbody');
  assert.strictEqual(resolved.provenance, 'components.Rigidbody');
  assert.strictEqual(resolved.value.mass, 9);
  assert.deepStrictEqual(resolved.conflicts.map(item => item.storage), ['rigidbody']);

  const written = codec.write(entity, 'Rigidbody', { mass: 12, custom: 'still-kept' }, { storage: 'preserve' });
  assert.deepStrictEqual(written, { mass: 12, custom: 'still-kept' });
  assert.deepStrictEqual(entity.components.Rigidbody, written);
  assert.strictEqual(entity.rigidbody.mass, 1);

  assert.strictEqual(codec.remove(entity, 'Rigidbody'), true);
  assert.strictEqual(entity.components.Rigidbody, undefined);
  assert.strictEqual(codec.resolve(entity, 'Rigidbody').storage, 'rigidbody');
});

test('supports canonical writes while leaving unrelated entity data untouched', () => {
  const codec = createDefaultEntityCodec();
  const entity = { id: 'npc', name: 'NPC', customTopLevel: { future: 1 }, components: { FutureData: { enabled: true } } };
  codec.write(entity, 'Rigidbody', { mass: 3, futurePhysics: 7 }, { storage: 'canonical' });
  assert.deepStrictEqual(entity.components.Rigidbody, { mass: 3, futurePhysics: 7 });
  assert.deepStrictEqual(entity.components.FutureData, { enabled: true });
  assert.deepStrictEqual(entity.customTopLevel, { future: 1 });

  const sparse = { id: 'sparse' };
  codec.write(sparse, 'Renderable');
  assert.deepStrictEqual(sparse.components.Renderable, {});
});

test('rejects provenance that belongs to another component without mutating it', () => {
  const codec = createDefaultEntityCodec();
  const entity = { id: 'storage-guard', collider: { shape: 'box' }, prefab: true, assetId: 'prefab', kind: 'sprite' };
  assert.throws(
    () => codec.write(entity, 'Rigidbody', { mass: 2 }, { storage: 'collider' }),
    error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_STORAGE'
  );
  assert.deepStrictEqual(entity.collider, { shape: 'box' });
  assert.throws(
    () => codec.remove(entity, 'Renderable', { provenance: 'flat-prefab' }),
    error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_STORAGE'
  );
  assert.strictEqual(entity.prefab, true);
  assert.strictEqual(entity.assetId, 'prefab');

  codec.write(entity, 'Rigidbody', { mass: 3 }, { storage: 'components.Body' });
  assert.deepStrictEqual(entity.components.Body, { mass: 3 });
});

test('preserves effective legacy field spelling and Prefab asset data on writes', () => {
  const codec = createDefaultEntityCodec();
  const longTransform = { id: 'long-transform', rotation: 1, rot: 99, scaleX: 2, sx: 99, scaleY: 3, sy: 99 };
  codec.write(longTransform, 'Transform', { rotation: 4, scaleX: 5, scaleY: 6 }, { storage: 'preserve' });
  assert.strictEqual(longTransform.rotation, 4);
  assert.strictEqual(longTransform.scaleX, 5);
  assert.strictEqual(longTransform.scaleY, 6);
  assert.strictEqual(longTransform.rot, 99);
  assert.strictEqual(longTransform.sx, 99);
  assert.strictEqual(longTransform.sy, 99);

  const shortTransform = { id: 'short-transform', rot: 1, sx: 2, sy: 3 };
  codec.write(shortTransform, 'Transform', { rotation: 4, scaleX: 0, scaleY: 6 }, { storage: 'preserve' });
  assert.deepStrictEqual({ rot: shortTransform.rot, sx: shortTransform.sx, sy: shortTransform.sy }, { rot: 4, sx: 0, sy: 6 });
  assert.strictEqual(shortTransform.rotation, undefined);
  assert.strictEqual(shortTransform.scaleX, undefined);

  const renderable = { id: 'renderable', kind: 'sprite', width: 10, w: 99, height: 20, h: 99 };
  codec.write(renderable, 'Renderable', { kind: 'sprite', width: 30, height: 40 }, { storage: 'preserve' });
  assert.strictEqual(renderable.width, 30);
  assert.strictEqual(renderable.height, 40);
  assert.strictEqual(renderable.w, 99);
  assert.strictEqual(renderable.h, 99);

  const prefab = { id: 'prefab', prefab: true, assetId: 'old' };
  codec.write(prefab, 'PrefabInstance', { assetId: 'new' }, { storage: 'preserve' });
  assert.strictEqual(prefab.prefab, true);
  assert.strictEqual(prefab.assetId, 'new');
  assert.strictEqual(prefab.components, undefined);
  codec.write(prefab, 'PrefabInstance', { assetId: null }, { storage: 'preserve' });
  assert.strictEqual(prefab.assetId, null);

  const promotedPrefab = { id: 'promoted-prefab', prefab: true, assetId: 'shared-old', unrelated: { keep: true } };
  const promotedValue = { assetId: 'component-new', prefabId: 'enemy', overrides: { speed: 2 }, extension: true };
  codec.write(promotedPrefab, 'PrefabInstance', promotedValue, { storage: 'preserve' });
  assert.strictEqual(promotedPrefab.prefab, false);
  assert.strictEqual(promotedPrefab.assetId, 'shared-old');
  assert.deepStrictEqual(promotedPrefab.components.PrefabInstance, promotedValue);
  assert.deepStrictEqual(promotedPrefab.unrelated, { keep: true });
  assert.strictEqual(codec.resolve(promotedPrefab, 'PrefabInstance').storage, 'components.PrefabInstance');
  assert.strictEqual(codec.resolve(promotedPrefab, 'Renderable').found, false);
  assert.strictEqual(codec.validate(promotedPrefab, { strict: true }).some(item => item.severity === 'error'), false);

  const newPrefab = { id: 'new-prefab' };
  codec.write(newPrefab, 'PrefabInstance');
  assert.deepStrictEqual(newPrefab.components.PrefabInstance, {});
  assert.strictEqual(newPrefab.prefab, undefined);
});

test('losslessly promotes unrepresentable compact legacy components to canonical storage', () => {
  const codec = createDefaultEntityCodec();
  const cases = [
    {
      type: 'Name', entity: { id: 'name-upgrade', name: 'Old', unrelated: 1 },
      value: { value: 'New', locale: 'fa' }, retired: value => !hasOwn(value, 'name')
    },
    {
      type: 'Transform', entity: { id: 'transform-upgrade', x: 1, y: 2, sx: 1, unrelated: 2 },
      value: { x: 4, scaleX: 0, extension: true }, retired: value => !hasOwn(value, 'x') && !hasOwn(value, 'y') && !hasOwn(value, 'sx')
    },
    {
      type: 'Renderable', entity: { id: 'renderable-upgrade', kind: 'sprite', width: 10, height: 20, unrelated: 3 },
      value: { kind: 'sprite', width: 30, height: 40, extension: true }, retired: value => !hasOwn(value, 'kind') && !hasOwn(value, 'width') && !hasOwn(value, 'height')
    },
    {
      type: 'Hidden', entity: { id: 'hidden-upgrade', visible: false, unrelated: 4 },
      value: { reason: 'editor' }, retired: value => value.visible === true
    },
    {
      type: 'Locked', entity: { id: 'locked-upgrade', locked: true, unrelated: 5 },
      value: { owner: 'tool' }, retired: value => value.locked === false
    }
  ];

  for (const item of cases) {
    const normalized = codec.write(item.entity, item.type, item.value, { storage: 'preserve' });
    assert.deepStrictEqual(normalized, item.value);
    assert.deepStrictEqual(item.entity.components[item.type], item.value);
    assert.strictEqual(item.retired(item.entity), true, `${item.type} legacy projection was not retired`);
    assert.strictEqual(item.entity.unrelated, cases.indexOf(item) + 1);
    assert.strictEqual(codec.resolve(item.entity, item.type).storage, `components.${item.type}`);
    assert.strictEqual(codec.validate(item.entity, { strict: true }).some(diagnostic => diagnostic.severity === 'error'), false);
  }

  const blocked = { id: 'blocked-upgrade', name: 'Old', components: 'invalid' };
  assert.throws(
    () => codec.write(blocked, 'Name', { value: 'New', locale: 'fa' }, { pointer: '/entity/name' }),
    error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_MAP' && error.pointer === '/entity/components'
  );
  assert.strictEqual(blocked.name, 'Old');
  assert.strictEqual(blocked.components, 'invalid');

  for (const [type, entity, value, pointer] of [
    ['Hidden', { id: 'blocked-hidden', visible: false, components: 'invalid' }, { reason: 'editor' }, '/entity/visible'],
    ['Locked', { id: 'blocked-locked', locked: true, components: 'invalid' }, { owner: 'tool' }, '/entity/locked']
  ]) {
    assert.throws(
      () => codec.write(entity, type, value, { pointer }),
      error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_MAP' && error.pointer === '/entity/components'
    );
  }
});

test('preserves a shared legacy Prefab assetId when retiring flat Renderable storage', () => {
  const codec = createDefaultEntityCodec();
  const promoted = { id: 'shared-promote', prefab: true, assetId: 'prefab-a', kind: 'sprite', w: 10, h: 20 };
  codec.write(promoted, 'Renderable', { kind: 'sprite', width: 30, height: 40, extension: true }, { storage: 'preserve' });
  assert.strictEqual(promoted.prefab, true);
  assert.strictEqual(promoted.assetId, 'prefab-a');
  assert.deepStrictEqual(promoted.components.Renderable, { kind: 'sprite', width: 30, height: 40, extension: true });
  assert.deepStrictEqual(codec.resolve(promoted, 'PrefabInstance').value, { assetId: 'prefab-a' });
  assert.strictEqual(codec.resolve(promoted, 'Renderable').conflicts.length, 0);
  assert.strictEqual(codec.validate(promoted, { strict: true }).some(item => item.severity === 'error'), false);

  const removed = { id: 'shared-remove', prefab: true, assetId: 'prefab-b', kind: 'sprite', w: 12, h: 14 };
  assert.strictEqual(codec.remove(removed, 'Renderable'), true);
  assert.strictEqual(removed.prefab, true);
  assert.strictEqual(removed.assetId, 'prefab-b');
  assert.deepStrictEqual(codec.resolve(removed, 'PrefabInstance').value, { assetId: 'prefab-b' });
  assert.strictEqual(codec.resolve(removed, 'Renderable').found, false);

  const renderableWrite = { id: 'shared-render-write', prefab: true, assetId: 'prefab-c', kind: 'sprite', w: 16, h: 18 };
  codec.write(renderableWrite, 'Renderable', { kind: 'sprite', width: 20, height: 22, assetId: 'render-c' }, { storage: 'preserve' });
  assert.strictEqual(renderableWrite.assetId, 'prefab-c');
  assert.deepStrictEqual(codec.resolve(renderableWrite, 'PrefabInstance').value, { assetId: 'prefab-c' });
  assert.strictEqual(codec.resolve(renderableWrite, 'Renderable').storage, 'components.Renderable');
  assert.strictEqual(codec.resolve(renderableWrite, 'Renderable').value.assetId, 'render-c');
  assert.strictEqual(codec.validate(renderableWrite, { strict: true }).some(item => item.severity === 'error'), false);

  const prefabWrite = { id: 'shared-prefab-write', prefab: true, assetId: 'render-d', kind: 'sprite', w: 24, h: 26 };
  codec.write(prefabWrite, 'PrefabInstance', { assetId: 'prefab-d' }, { storage: 'preserve' });
  assert.strictEqual(prefabWrite.prefab, false);
  assert.strictEqual(prefabWrite.assetId, 'render-d');
  assert.strictEqual(codec.resolve(prefabWrite, 'Renderable').value.assetId, 'render-d');
  assert.strictEqual(codec.resolve(prefabWrite, 'PrefabInstance').storage, 'components.PrefabInstance');
  assert.strictEqual(codec.resolve(prefabWrite, 'PrefabInstance').value.assetId, 'prefab-d');
  assert.strictEqual(codec.validate(prefabWrite, { strict: true }).some(item => item.severity === 'error'), false);

  const exclusivePrefab = { id: 'exclusive-prefab', prefab: true, assetId: 'prefab-only' };
  assert.strictEqual(codec.remove(exclusivePrefab, 'PrefabInstance'), true);
  assert.strictEqual(exclusivePrefab.prefab, false);
  assert.strictEqual(hasOwn(exclusivePrefab, 'assetId'), false);
  assert.strictEqual(codec.resolve(exclusivePrefab, 'Renderable').found, false, 'removing an asset-only Prefab must not create a ghost Renderable');

  const sharedPrefab = { id: 'shared-prefab-remove', prefab: true, assetId: 'shared-asset', kind: 'sprite', w: 8, h: 9 };
  assert.strictEqual(codec.remove(sharedPrefab, 'PrefabInstance'), true);
  assert.strictEqual(sharedPrefab.assetId, 'shared-asset');
  assert.strictEqual(codec.resolve(sharedPrefab, 'Renderable').value.assetId, 'shared-asset');
});

test('overlays Transform per field with component precedence and retains zero values', () => {
  const codec = createDefaultEntityCodec();
  const entity = {
    id: 'scaled', x: 40, y: 20, rot: 15, sx: 0, sy: 2,
    transform: { y: 25, scaleY: 0 },
    components: { Transform: { x: 50, pluginField: 'preserved' } }
  };
  const transform = codec.resolve(entity, 'Transform');
  assert.strictEqual(transform.storage, 'components.Transform');
  assert.deepStrictEqual(transform.value, {
    x: 50, y: 25, rotation: 15, scaleX: 0, scaleY: 0, pluginField: 'preserved'
  });
  assert(transform.conflicts.length >= 1);

  const complementary = { id: 'complementary', x: 1, components: { Transform: { y: 2 } } };
  const complementaryTransform = codec.resolve(complementary, 'Transform');
  assert.strictEqual(complementaryTransform.value.x, 1);
  assert.strictEqual(complementaryTransform.value.y, 2);
  assert.deepStrictEqual(complementaryTransform.conflicts, []);
  assert.strictEqual(codec.validate(complementary, { strict: true }).some(item => item.code === 'E_COMPONENT_CONFLICT'), false);
});

test('lists and decodes unknown custom components without losing fields', () => {
  const codec = createDefaultEntityCodec();
  const entity = {
    id: 'enemy', name: 'Enemy', parentId: 'root', x: 1, y: 2,
    components: {
      EnemyAI: { state: 'idle', nested: { threshold: 0.25 }, futureFlag: true },
      BoxCollider: { width: 10, height: 20 },
      BoxCollider2D: { width: 12, height: 22 },
      CircleCollider: { radius: 5 },
      CircleCollider2D: { radius: 6 }
    }
  };
  const listed = codec.list(entity);
  assert(listed.some(item => item.type === 'EnemyAI' && item.storage === 'components.EnemyAI'));
  const runtime = codec.decodeToRuntime(entity);
  assert.strictEqual(runtime.id, 'enemy');
  assert.strictEqual(runtime.parentId, 'root');
  assert.deepStrictEqual(runtime.components.EnemyAI, entity.components.EnemyAI);
  for (const type of ['BoxCollider', 'BoxCollider2D', 'CircleCollider', 'CircleCollider2D']) assert(hasOwn(runtime.components, type));
  assert.deepStrictEqual(entity.components.EnemyAI.nested, { threshold: 0.25 });
});

test('maps authored rectangle colliders only in the runtime copy', () => {
  const codec = createDefaultEntityCodec();
  const entity = { id: 'wall', components: { Collider: { shape: 'rectangle', width: 10, height: 20, extension: true } } };
  const runtime = codec.decodeToRuntime(entity);
  assert.strictEqual(runtime.components.Collider.shape, 'box');
  assert.strictEqual(runtime.components.Collider.extension, true);
  assert.strictEqual(entity.components.Collider.shape, 'rectangle');
});

test('requires explicit Collider ids to be unique per Entity without rewriting wrappers or unknown fields', () => {
  const registry = createDefaultComponentRegistry();
  const wrapped = {
    colliders: [
      { id: 'hurtbox', shape: 'rectangle', extension: { keep: 1 } },
      { id: 'hurtbox', shape: 'circle', radius: 8, futureFixture: true }
    ],
    futureWrapper: { keep: true }
  };
  const source = JSON.stringify(wrapped);
  const componentDiagnostics = registry.validate('Collider', wrapped, { pointer: '/components/Collider' });
  assert(componentDiagnostics.some(item => (
    item.code === 'E_COLLIDER_ID_DUPLICATE'
    && item.pointer === '/components/Collider/colliders/1/id'
    && item.details.firstPointer === '/components/Collider/colliders/0/id'
    && item.details.colliderId === 'hurtbox'
  )));
  assert.strictEqual(JSON.stringify(wrapped), source, 'validation must preserve the wrapper and unknown fields');

  const implicitIds = registry.validate('Collider', [{ id: '' }, {}, { id: '' }], { pointer: '/components/Collider' });
  assert.strictEqual(implicitIds.some(item => item.code === 'E_COLLIDER_ID_DUPLICATE'), false, 'empty ids use distinct generated runtime ids');

  const codec = createDefaultEntityCodec();
  const entity = {
    id: 'fighter',
    components: {
      Collider: { shapes: [{ id: 'shared', extension: 'kept' }], wrapperExtension: 2 },
      BoxCollider2D: { id: 'shared', width: 12, height: 14, custom: { keep: true } }
    }
  };
  const entitySource = JSON.stringify(entity);
  const entityDiagnostics = codec.validate(entity, { pointer: '/scenes/0/objects/0' });
  const duplicate = entityDiagnostics.find(item => item.code === 'E_COLLIDER_ID_DUPLICATE');
  assert.strictEqual(duplicate.pointer, '/scenes/0/objects/0/components/BoxCollider2D/id');
  assert.strictEqual(duplicate.details.firstPointer, '/scenes/0/objects/0/components/Collider/shapes/0/id');
  assert.strictEqual(duplicate.details.entityId, 'fighter');
  assert.strictEqual(JSON.stringify(entity), entitySource, 'entity validation must remain non-mutating');
  assert.throws(
    () => codec.decodeToRuntime(entity),
    error => error instanceof ComponentSchemaError
      && error.code === 'E_COLLIDER_ID_DUPLICATE'
      && error.pointer === '/components/BoxCollider2D/id'
  );
});

test('prevents removal of required Name and Transform components', () => {
  const codec = createDefaultEntityCodec();
  const entity = { id: 'required', name: 'Required', x: 0, y: 0 };
  for (const type of ['Name', 'Transform']) {
    assert.throws(
      () => codec.remove(entity, type),
      error => error instanceof ComponentSchemaError && error.code === 'E_REQUIRED_COMPONENT'
    );
  }
});

test('returns precise JSON pointers for component and entity validation', () => {
  const registry = createDefaultComponentRegistry();
  const componentDiagnostics = registry.validate('Rigidbody', { mass: 'heavy' }, { pointer: '/components/Rigidbody' });
  assert(componentDiagnostics.some(item => item.code === 'E_COMPONENT_TYPE' && item.pointer === '/components/Rigidbody/mass'));
  const nestedColliderDiagnostics = registry.validate('CircleCollider', { colliders: [42] }, { pointer: '/components/CircleCollider' });
  assert(nestedColliderDiagnostics.some(item => item.code === 'E_COMPONENT_TYPE' && item.pointer === '/components/CircleCollider/colliders/0'));

  const codec = createDefaultEntityCodec();
  const entityDiagnostics = codec.validate({ id: 'bad', components: { health: { value: 1 }, Rigidbody: { mass: -1 } } });
  assert(entityDiagnostics.some(item => item.code === 'E_COMPONENT_NAME' && item.pointer === '/components/health'));
  assert(entityDiagnostics.some(item => item.code === 'E_COMPONENT_EXCLUSIVE_MINIMUM' && item.pointer === '/components/Rigidbody/mass'));

  const flatDiagnostics = codec.validate({ id: 'flat-bad', rot: 'nope', sx: 'nope', w: 'nope' });
  assert(flatDiagnostics.some(item => item.code === 'E_COMPONENT_TYPE' && item.pointer === '/rot'));
  assert(flatDiagnostics.some(item => item.code === 'E_COMPONENT_TYPE' && item.pointer === '/sx'));
  assert(flatDiagnostics.some(item => item.code === 'E_COMPONENT_TYPE' && item.pointer === '/w'));

  const whitespaceId = codec.validate({ id: '   ' });
  assert(whitespaceId.some(item => item.code === 'E_ENTITY_ID' && item.pointer === '/id'));

  assert.throws(
    () => codec.write({ id: 'write-pointer', sx: 1 }, 'Transform', { scaleX: 'nope' }, { pointer: '/entity' }),
    error => error instanceof ComponentSchemaError && error.pointer === '/entity/sx' && error.diagnostics.some(item => item.pointer === '/entity/sx')
  );
  assert.throws(
    () => codec.write({ id: 'name-pointer', name: 'Old' }, 'Name', { value: 3 }, { pointer: '/entity/name' }),
    error => error instanceof ComponentSchemaError && error.pointer === '/entity/name' && error.diagnostics.some(item => item.pointer === '/entity/name')
  );
  assert.throws(
    () => codec.write({ id: 'prefab-pointer', prefab: true, assetId: 'old' }, 'PrefabInstance', { assetId: 4 }, { pointer: '/entity/prefab' }),
    error => error instanceof ComponentSchemaError && error.pointer === '/entity/assetId' && error.diagnostics.some(item => item.pointer === '/entity/assetId')
  );
  assert.throws(
    () => codec.write({ id: 'create-pointer', x: 'bad' }, 'Transform', undefined, { pointer: '/scenes/0/objects/0' }),
    error => error instanceof ComponentSchemaError && error.pointer === '/scenes/0/objects/0/x' && error.diagnostics.some(item => item.pointer === '/scenes/0/objects/0/x')
  );
  assert.throws(
    () => codec.decodeToRuntime({ id: 'runtime-pointer', sx: '0' }),
    error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_TYPE' && error.pointer === '/sx'
  );

  const conflictDiagnostics = codec.validate({ id: 'conflict', rigidbody: { mass: 1 }, components: { Rigidbody: { mass: 2 } } });
  assert(conflictDiagnostics.some(item => item.code === 'E_COMPONENT_CONFLICT' && item.severity === 'warning' && item.pointer === '/components/Rigidbody'));
  const strictDiagnostics = codec.validate({ id: 'conflict', rigidbody: { mass: 1 }, components: { Rigidbody: { mass: 2 } } }, { strict: true });
  assert(strictDiagnostics.some(item => item.code === 'E_COMPONENT_CONFLICT' && item.severity === 'error'));
});

test('runs ordered component migrations and rejects missing steps', () => {
  const registry = new ComponentSchemaRegistry();
  registry.register({
    type: 'Mover',
    schemaVersion: 3,
    schemas: {
      authoring: { type: 'object', properties: { speed: { type: 'number' }, enabled: { type: 'boolean' } }, required: ['speed', 'enabled'], additionalProperties: true }
    },
    migrations: {
      1: value => ({ ...value, speed: value.velocity }),
      2: value => ({ ...value, enabled: value.enabled !== false })
    }
  });
  const migrated = registry.migrate('Mover', { velocity: 4, unknown: { keep: true } }, 1);
  assert.strictEqual(migrated.speed, 4);
  assert.strictEqual(migrated.enabled, true);
  assert.deepStrictEqual(migrated.unknown, { keep: true });
  assert.deepStrictEqual(registry.migrate('Mover', migrated, 3), migrated);

  const broken = new ComponentSchemaRegistry();
  broken.register({ type: 'Broken', schemaVersion: 2, schema: { type: 'object' } });
  assert.throws(() => broken.migrate('Broken', {}, 1), error => error.code === 'E_COMPONENT_MIGRATION_MISSING');
});

test('filters runtime-derived fields from authoring but retains them in runtime and snapshots', () => {
  const registry = createDefaultComponentRegistry();
  const transform = { x: 1, world: [1, 0, 0, 1, 10, 20], extension: true };
  const authoredTransform = registry.normalize('Transform', transform, { profile: 'authoring' });
  const runtimeTransform = registry.normalize('Transform', transform, { profile: 'runtime' });
  const snapshotTransform = registry.normalize('Transform', transform, { profile: 'snapshot' });
  assert.strictEqual(authoredTransform.world, undefined);
  assert.deepStrictEqual(runtimeTransform.world, transform.world);
  assert.deepStrictEqual(snapshotTransform.world, transform.world);
  assert.strictEqual(authoredTransform.extension, true);

  const rigidbody = registry.normalize('Rigidbody', { mass: 1, inverseMass: 1, inertia: 8, extension: 2 }, { profile: 'authoring' });
  assert.deepStrictEqual(rigidbody, { mass: 1, extension: 2 });

  const particleEmitter = {
    assetId: 'sparks', autoplay: true, particles: [{ id: 'p1' }], emissionAccumulator: 0.5,
    completed: false, rngState: 42, extension: { keep: true }
  };
  const authoredEmitter = registry.normalize('ParticleEmitter', particleEmitter, { profile: 'authoring' });
  const runtimeEmitter = registry.normalize('ParticleEmitter', particleEmitter, { profile: 'runtime' });
  assert.deepStrictEqual(authoredEmitter, { assetId: 'sparks', autoplay: true, extension: { keep: true } });
  assert.deepStrictEqual(runtimeEmitter, particleEmitter);
  assert.deepStrictEqual(registry.describe('ParticleEmitter').runtimeOnlyFields, ['particles', 'emissionAccumulator', 'completed', 'rngState']);

  const colliders = registry.normalize('Collider', [
    { shape: 'box', source: { runtime: true }, extension: 1 }
  ], { profile: 'authoring' });
  assert.deepStrictEqual(colliders, [{ shape: 'box', extension: 1 }]);

  const codec = createDefaultEntityCodec();
  const entity = { id: 'derived', components: { Transform: transform } };
  codec.write(entity, 'Transform', transform, { storage: 'canonical' });
  assert.strictEqual(entity.components.Transform.world, undefined);
  assert.strictEqual(entity.components.Transform.extension, true);

  const runtime = codec.decodeToRuntime({ id: 'runtime-defaults', name: 'Runtime', x: 0, y: 0 });
  assert.deepStrictEqual(runtime.components.Transform.world, [1, 0, 0, 1, 0, 0]);
  assert.deepStrictEqual(runtime.components.Name, { value: 'Runtime' });
});

test('rejects circular and otherwise non-JSON component data', () => {
  const registry = createDefaultComponentRegistry();
  const circular = { value: 1 };
  circular.self = circular;
  const circularDiagnostics = registry.validate('CustomData', circular, { pointer: '/components/CustomData' });
  assert(circularDiagnostics.some(item => item.code === 'E_COMPONENT_JSON_CIRCULAR' && item.pointer === '/components/CustomData/self'));
  assert.throws(() => registry.normalize('CustomData', circular), error => error instanceof ComponentSchemaError && error.code === 'E_COMPONENT_JSON_CIRCULAR');

  for (const [value, expectedCode] of [
    [{ callback() {} }, 'E_COMPONENT_JSON_TYPE'],
    [{ missing: undefined }, 'E_COMPONENT_JSON_TYPE'],
    [{ amount: NaN }, 'E_COMPONENT_JSON_NUMBER'],
    [{ amount: Infinity }, 'E_COMPONENT_JSON_NUMBER'],
    [new Date(), 'E_COMPONENT_JSON_OBJECT']
  ]) {
    const diagnostics = registry.validate('CustomData', value);
    assert(diagnostics.some(item => item.code === expectedCode), `${expectedCode} not reported`);
  }
});

test('normalizes legacy Particle Assets into the canonical v1 contract without mutating extensions', () => {
  assert.deepStrictEqual(PARTICLE_CURVE_PROPERTIES, ['emission', 'scale', 'speed', 'opacity', 'hue']);
  assert.deepStrictEqual(PARTICLE_CURVE_INTERPOLATIONS, ['linear', 'step', 'cubic']);
  assert.strictEqual(PARTICLE_ASSET_SCHEMA.properties.curves.items, PARTICLE_CURVE_SCHEMA);
  assert.strictEqual(PARTICLE_CURVE_SCHEMA.properties.keys.items, PARTICLE_CURVE_KEY_SCHEMA);
  assert.deepStrictEqual(PARTICLE_ASSET_SCHEMA.required, [
    'id', 'name', 'duration', 'loop', 'maxParticles', 'emission', 'lifetime', 'velocity', 'shape', 'appearance', 'curves'
  ]);

  const legacy = {
    name: 'Magic Sparkle', amount: 140, rate: 90, lifetime: 1.6, speed: 120, spread: 55,
    gravity: 65, radius: 70, scale: 1.25, opacity: 0.8, hue: 42, blend: 'Additive', playing: true, loop: true,
    futureAsset: { keep: true }, curves: [
      { property: 'opacity', interpolation: 'cubic', futureCurve: 7, keys: [
        { time: 1, value: 0, inTangent: -2, futureKey: true },
        { time: 0, value: 1, outTangent: 0 }
      ] }
    ]
  };
  const before = JSON.stringify(legacy);
  const normalized = normalizeParticleAsset(legacy);
  assert.strictEqual(JSON.stringify(legacy), before, 'Particle normalization must not mutate its input');
  assert.strictEqual(normalized.id, 'magic-sparkle');
  assert.strictEqual(normalized.maxParticles, 140);
  assert.deepStrictEqual(normalized.emission, { rate: 90, burst: 0 });
  assert.deepStrictEqual(normalized.lifetime, { min: 1.6, max: 1.6 });
  assert.deepStrictEqual(normalized.velocity, { speedMin: 120, speedMax: 120, angle: -90, spread: 55, gravityX: 0, gravityY: 65 });
  assert.deepStrictEqual(normalized.shape, { type: 'circle', radius: 70, width: 0, height: 0 });
  assert.deepStrictEqual(normalized.appearance, { color: '#ffffff', blend: 'additive', baseScale: 1.25, baseOpacity: 0.8, baseHue: 42 });
  assert.strictEqual(normalized.futureAsset.keep, true);
  assert.strictEqual(normalized.curves[0].futureCurve, 7);
  assert.deepStrictEqual(normalized.curves[0].keys.map(key => key.time), [0, 1]);
  assert.strictEqual(normalized.curves[0].keys[1].futureKey, true);
  assert(normalized.curves[0].id);
  assert(normalized.curves[0].keys.every(key => key.id));
  assert.deepStrictEqual(validateParticleDocument([normalized]), []);
  const burstOnly = normalizeParticleAsset({ id: 'burst', name: 'Burst', duration: 0, emission: { rate: 0, burst: 8 } });
  assert.strictEqual(burstOnly.duration, 1, 'invalid zero duration falls back to the canonical default');
  assert.deepStrictEqual(validateParticleDocument([burstOnly]), []);

  const collisionSafe = normalizeParticleAssets([
    { name: 'Smoke', rate: 1 },
    { name: 'Smoke', rate: 2 },
    { ...normalizeParticleAsset({ name: 'Explicit' }), id: 'smoke' }
  ]);
  assert.deepStrictEqual(collisionSafe.map(asset => asset.id), ['smoke-2', 'smoke-3', 'smoke']);
});

test('samples linear, step, and cubic Particle curves in normalized time', () => {
  const keys = [{ id: 'a', time: 0, value: 0, outTangent: 0 }, { id: 'b', time: 1, value: 1, inTangent: 0 }];
  const source = JSON.stringify(keys);
  assert.strictEqual(sampleParticleCurve({ interpolation: 'linear', keys }, 0.25), 0.25);
  assert.strictEqual(sampleParticleCurve({ interpolation: 'step', keys }, 0.75), 0);
  assert.strictEqual(sampleParticleCurve({ interpolation: 'cubic', keys }, 0.25), 0.15625);
  assert.strictEqual(sampleParticleCurve({ interpolation: 'cubic', keys }, -1), 0);
  assert.strictEqual(sampleParticleCurve({ interpolation: 'cubic', keys }, 2), 1);
  assert.strictEqual(sampleParticleCurve({ interpolation: 'linear', keys: [{ id: 'only', time: 0.5, value: 7 }] }, 0.1), 7);
  assert.strictEqual(sampleParticleCurve({ interpolation: 'step', keys: [
    { id: 'first', time: 0, value: 2 }, { id: 'middle', time: 0.5, value: 5 }, { id: 'last', time: 1, value: 9 }
  ] }, 0.5), 5, 'an exact step key samples that key rather than the previous segment');
  assert.strictEqual(sampleParticleCurve({ interpolation: 'linear', keys: [] }, 0.5, { defaultValue: 3 }), 3);
  assert.strictEqual(JSON.stringify(keys), source, 'Curve sampling must not reorder or mutate authored keys');

  const linearTangents = [{ id: 'a', time: 0.2, value: 4 }, { id: 'b', time: 0.8, value: 10 }];
  assert.ok(Math.abs(sampleParticleCurve({ interpolation: 'cubic', keys: linearTangents }, 0.5) - 7) < 1e-12, 'missing cubic tangents fall back to the segment slope');
});

test('validates Particle Asset ranges, unique curves, sorted keys, and Scene/Prefab emitter references', () => {
  const asset = normalizeParticleAsset({
    id: 'sparks', name: 'Sparks', futureAsset: true,
    curves: [{ id: 'opacity', property: 'opacity', interpolation: 'linear', keys: [
      { id: 'opaque', time: 0, value: 1 }, { id: 'clear', time: 1, value: 0 }
    ] }]
  });
  const project = {
    format: 'AH2D', version: 4, particles: [asset],
    scenes: [{ id: 'main', objects: [{ id: 'scene-emitter', components: { ParticleEmitter: { assetId: 'sparks', autoplay: true } } }] }],
    currentSceneId: 'main', scene: [],
    prefabs: [{ id: 'fx', rootEntityId: 'source', revision: 0, entities: [
      { id: 'source', components: { ParticleEmitter: { assetId: 'sparks', loop: false } } }
    ] }]
  };
  const before = JSON.stringify(project);
  assert.deepStrictEqual(validateParticleDocument(project), []);
  assert.deepStrictEqual(assertParticleDocument(project), []);
  assert.strictEqual(JSON.stringify(project), before, 'Particle validation must be non-mutating');

  const missingBinding = JSON.parse(JSON.stringify(project));
  delete missingBinding.scenes[0].objects[0].components.ParticleEmitter.assetId;
  assert(validateParticleDocument(missingBinding).some(item => item.code === 'E_PARTICLE_EMITTER_ASSET'));

  const legacyEmitter = JSON.parse(JSON.stringify(project));
  legacyEmitter.scenes[0].objects[0].components.ParticleEmitter = {
    assetId: '  ', name: 'Inline sparks', amount: 20, rate: 4, lifetime: 0.5, speed: 12, futureEmitter: true
  };
  const legacyEmitterCompat = validateParticleDocument(legacyEmitter);
  assert(legacyEmitterCompat.some(item => item.code === 'W_PARTICLE_EMITTER_LEGACY' && item.severity === 'warning'));
  assert.strictEqual(legacyEmitterCompat.some(item => item.severity === 'error'), false);
  assert(validateParticleDocument(legacyEmitter, { strict: true }).some(item => item.code === 'E_PARTICLE_EMITTER_LEGACY'));

  const dangling = JSON.parse(JSON.stringify(project));
  dangling.prefabs[0].entities[0].components.ParticleEmitter.assetId = 'missing';
  assert(validateParticleDocument(dangling).some(item => item.code === 'E_PARTICLE_ASSET_REFERENCE' && item.pointer === '/prefabs/0/entities/0/components/ParticleEmitter/assetId'));

  const emptyScenesWithActiveMirror = {
    format: 'AH2D', version: 4, particles: [asset], scenes: [],
    scene: [{ id: 'mirror-emitter', components: { ParticleEmitter: { assetId: 'missing' } } }]
  };
  assert(validateParticleDocument(emptyScenesWithActiveMirror).some(item => (
    item.code === 'E_PARTICLE_ASSET_REFERENCE'
    && item.pointer === '/scene/0/components/ParticleEmitter/assetId'
  )), 'an empty Scenes collection must fall back to the active Scene mirror used by Engine.load');

  const nonemptyScenesSuppressStaleMirror = JSON.parse(JSON.stringify(project));
  nonemptyScenesSuppressStaleMirror.scene = [{ id: 'stale-mirror', components: { ParticleEmitter: { assetId: 'missing' } } }];
  assert.strictEqual(
    validateParticleDocument(nonemptyScenesSuppressStaleMirror).some(item => item.pointer.startsWith('/scene/')),
    false,
    'non-empty canonical Scenes remain authoritative over the active Scene mirror'
  );

  const invalidOverrides = JSON.parse(JSON.stringify(project));
  invalidOverrides.scenes[0].objects[0].components.ParticleEmitter.overrides = {
    id: 'replacement-is-forbidden',
    emission: { rate: -4 },
    lifetime: { min: 9, max: 1 },
    shape: { type: 'triangle' }
  };
  const overrideDiagnostics = validateParticleDocument(invalidOverrides, { strict: true });
  assert(overrideDiagnostics.some(item => item.code === 'E_PARTICLE_OVERRIDE_IDENTITY' && item.pointer === '/scenes/0/objects/0/components/ParticleEmitter/overrides/id'));
  assert(overrideDiagnostics.some(item => item.code === 'E_PARTICLE_EMISSION_RATE' && item.pointer === '/scenes/0/objects/0/components/ParticleEmitter/overrides/emission/rate'));
  assert(overrideDiagnostics.some(item => item.code === 'E_PARTICLE_LIFETIME_RANGE' && item.pointer === '/scenes/0/objects/0/components/ParticleEmitter/overrides/lifetime'));
  assert(overrideDiagnostics.some(item => item.code === 'E_PARTICLE_SHAPE_TYPE' && item.pointer === '/scenes/0/objects/0/components/ParticleEmitter/overrides/shape/type'));

  const validOverrides = JSON.parse(JSON.stringify(project));
  validOverrides.scenes[0].objects[0].components.ParticleEmitter.overrides = {
    emission: { rate: 24 }, appearance: { baseOpacity: 0.5 }, futureOverride: { keep: true }
  };
  assert.deepStrictEqual(validateParticleDocument(validOverrides, { strict: true }), []);

  const malformed = JSON.parse(JSON.stringify(asset));
  malformed.lifetime = { min: 3, max: 1 };
  malformed.velocity = { ...malformed.velocity, speedMin: 10, speedMax: 2 };
  malformed.curves.push({
    id: 'opacity', property: 'opacity', interpolation: 'cubic', keys: [
      { id: 'same', time: 0.75, value: 0 },
      { id: 'same', time: 0.25, value: 1 },
      { id: 'third', time: 0.25, value: 2 }
    ]
  });
  const codes = new Set(validateParticleDocument([malformed]).map(item => item.code));
  for (const code of [
    'E_PARTICLE_LIFETIME_RANGE', 'E_PARTICLE_SPEED_RANGE', 'E_PARTICLE_CURVE_ID_DUPLICATE',
    'E_PARTICLE_CURVE_PROPERTY_DUPLICATE', 'E_PARTICLE_CURVE_KEY_ID_DUPLICATE',
    'E_PARTICLE_CURVE_KEY_TIME_DUPLICATE', 'E_PARTICLE_CURVE_KEY_ORDER'
  ]) assert(codes.has(code), `${code} was not reported`);

  const numericStrings = JSON.parse(JSON.stringify(asset));
  numericStrings.duration = '1';
  numericStrings.curves[0].keys[0].time = '0';
  assert.strictEqual(validateParticleDocument([numericStrings]).some(item => item.severity === 'error'), false);
  assert(validateParticleDocument([numericStrings], { strict: true }).some(item => item.code === 'E_PARTICLE_DURATION'));

  const canonicalWithoutId = { ...asset };
  delete canonicalWithoutId.id;
  assert(validateParticleDocument([canonicalWithoutId]).some(item => item.code === 'E_PARTICLE_ASSET_ID'));

  const legacy = { name: 'Legacy', amount: 12, rate: 4, lifetime: 1, futureLegacy: true };
  assert(validateParticleDocument({ particles: [legacy] }).some(item => item.code === 'W_PARTICLE_ASSET_LEGACY'));
  assert.throws(() => assertParticleDocument({ particles: [legacy] }, { strict: true }), error => error instanceof ComponentSchemaError && error.code === 'E_PARTICLE_ASSET_LEGACY');

  const standalone = { format: 'AH2D.Particle', version: 1, ...asset };
  assert.deepStrictEqual(validateParticleDocument(standalone), []);
  const missingStandaloneFormat = { ...standalone };
  delete missingStandaloneFormat.format;
  assert(validateParticleDocument(missingStandaloneFormat).some(item => (
    item.code === 'E_PARTICLE_DOCUMENT_FORMAT' && item.pointer === '/format'
  )), 'a bare Particle Asset must not be mistaken for an empty Project');
  const wrongStandaloneFormat = { ...standalone, format: 'AH2D.Particles' };
  assert(validateParticleDocument(wrongStandaloneFormat).some(item => (
    item.code === 'E_PARTICLE_DOCUMENT_FORMAT' && item.pointer === '/format'
  )), 'a Particle-like standalone dialect typo must be rejected');
  const malformedStandaloneEnvelope = { ...standalone, format: 'Other.Particle', version: 2 };
  const malformedStandaloneDiagnostics = validateParticleDocument(malformedStandaloneEnvelope);
  assert(malformedStandaloneDiagnostics.some(item => item.code === 'E_PARTICLE_DOCUMENT_FORMAT'));
  assert(malformedStandaloneDiagnostics.some(item => item.code === 'E_PARTICLE_DOCUMENT_VERSION'));
  const wrongStandaloneVersion = { ...standalone, version: 999 };
  assert(validateParticleDocument(wrongStandaloneVersion).some(item => item.code === 'E_PARTICLE_DOCUMENT_VERSION' && item.pointer === '/version'));
  const missingStandaloneVersion = { ...standalone };
  delete missingStandaloneVersion.version;
  assert(validateParticleDocument(missingStandaloneVersion).some(item => item.code === 'E_PARTICLE_DOCUMENT_VERSION'));
  assert.strictEqual(validateParticleDocument({ ...standalone, version: '1' }).some(item => item.code === 'E_PARTICLE_DOCUMENT_VERSION'), false);
  assert(validateParticleDocument({ ...standalone, version: '1' }, { strict: true }).some(item => item.code === 'E_PARTICLE_DOCUMENT_VERSION'));
  assert.deepStrictEqual(validateParticleDocument({
    format: 'AH2D', version: 4, currentSceneId: 'main', scenes: [{ id: 'main', objects: [] }],
    duration: 2, particles: []
  }), [], 'Universal Projects must not be classified as standalone Particle Assets');
  assert.deepStrictEqual(validateParticleDocument({ version: 3, entities: [{ id: 'runtime', components: { ParticleEmitter: { assetId: 'sparks' } } }] }), []);
});

test('normalizes canonical Shader Graphs with stable IDs, defaults, and unknown extensions intact', () => {
  assert.deepStrictEqual(SHADER_NODE_TYPES, [
    'sceneTexture', 'output', 'tint', 'grayscale', 'brightnessContrast',
    'saturation', 'invert', 'vignette', 'pixelate', 'chromaticAberration', 'mix'
  ]);
  assert.deepStrictEqual(SHADER_GRAPH_SCHEMA.required, [
    'id', 'name', 'version', 'domain', 'nodes', 'links', 'outputNodeId'
  ]);
  assert.strictEqual(SHADER_NODE_DEFINITIONS.mix.inputs.a, 'color');
  assert.strictEqual(SHADER_NODE_DEFINITIONS.mix.inputs.b, 'color');
  assert.strictEqual(SHADER_NODE_DEFINITIONS.chromaticAberration.parameters.amount.default, 2);
  assert.strictEqual(SHADER_NODE_DEFINITIONS.tint.parameters.color.pattern, SHADER_HEX_COLOR_PATTERN);
  assert.strictEqual(SHADER_GRAPH_DEFAULTS.domain, 'postProcess');
  assert.deepStrictEqual(POST_PROCESS_EFFECT_SCHEMA.required, ['id', 'type']);
  assert.strictEqual(POST_PROCESS_EFFECT_SCHEMA.properties.graphId.pattern, '\\S');
  assert.strictEqual(POST_PROCESS_EFFECT_SCHEMA.properties.parameters.type, 'object');
  assert.strictEqual(POST_PROCESS_EFFECT_SCHEMA.additionalProperties, true);
  assert.deepStrictEqual(POST_PROCESS_SCHEMA.required, ['effects']);
  assert.strictEqual(POST_PROCESS_SCHEMA.properties.effects.items, POST_PROCESS_EFFECT_SCHEMA);
  assert.strictEqual(POST_PROCESS_SCHEMA.additionalProperties, true);

  const source = {
    name: 'Dream Grade', futureGraph: { keep: true },
    nodes: [
      { id: 'scene', type: 'SCENETEXTURE', position: { x: '10.5', y: '-20', futureAxis: 3 }, parameters: {}, futureNode: 'keep' },
      { type: 'brightnesscontrast', position: { x: 210, y: 20 }, parameters: { brightness: 0.2, futureUniform: 7 } },
      { id: 'result', type: 'OUTPUT', position: { x: 420, y: 20 }, parameters: {} }
    ],
    links: [
      { id: 'source-grade', from: { nodeId: 'scene', port: 'color', futureEndpoint: true }, to: { nodeId: 'brightnesscontrast', port: 'color' }, futureLink: 1 },
      { from: { nodeId: 'brightnesscontrast', port: 'color' }, to: { nodeId: 'result', port: 'color' } }
    ],
    outputNodeId: 'result'
  };
  const before = JSON.stringify(source);
  const normalized = normalizeShaderGraph(source);
  assert.strictEqual(JSON.stringify(source), before, 'Shader Graph normalization must not mutate input');
  assert.strictEqual(normalized.id, 'dream-grade');
  assert.strictEqual(normalized.version, 1);
  assert.strictEqual(normalized.domain, 'postProcess');
  assert.strictEqual(normalized.nodes[0].type, 'sceneTexture');
  assert.strictEqual(normalized.nodes[1].type, 'brightnessContrast');
  assert.strictEqual(normalized.nodes[1].parameters.contrast, 1);
  assert.strictEqual(normalized.nodes[1].parameters.futureUniform, 7);
  assert.strictEqual(normalized.nodes[0].futureNode, 'keep');
  assert.strictEqual(normalized.nodes[0].position.x, 10.5, 'compatible numeric-string X coordinates must normalize to numbers');
  assert.strictEqual(normalized.nodes[0].position.y, -20, 'compatible numeric-string Y coordinates must normalize to numbers');
  assert.strictEqual(normalized.nodes[0].position.futureAxis, 3);
  assert.strictEqual(normalized.links[0].futureLink, 1);
  assert.strictEqual(normalized.links[0].from.futureEndpoint, true);
  assert(normalized.nodes[1].id);
  assert(normalized.links[1].id);
  assert.deepStrictEqual(validateShaderGraphDocument([normalized]), []);

  const defaults = normalizeShaderGraph({ name: 'Default Graph' });
  assert.deepStrictEqual(defaults.nodes.map(node => node.type), ['sceneTexture', 'output']);
  assert.deepStrictEqual(validateShaderGraphDocument(defaults, { strict: true }), []);
  const collisionSafe = normalizeShaderGraphs([
    { name: 'Grade' },
    { name: 'Grade' },
    { ...normalizeShaderGraph({ name: 'Explicit' }), id: 'grade' }
  ]);
  assert.deepStrictEqual(collisionSafe.map(graph => graph.id), ['grade-2', 'grade-3', 'grade']);
});

test('validates Shader Graph topology, ports, parameters, cycles, and Post Process references', () => {
  const graph = normalizeShaderGraph({ name: 'Valid Grade' });
  const project = {
    shaderGraphs: [{ ...graph, futureGraph: { keep: true } }],
    postProcess: { enabled: true, effects: [
      { id: 'grade', type: 'shaderGraph', graphId: graph.id, enabled: true, overrides: { future: true } }
    ] }
  };
  const before = JSON.stringify(project);
  assert.deepStrictEqual(validateShaderGraphDocument(project, { strict: true }), []);
  assert.deepStrictEqual(assertShaderGraphDocument(project, { strict: true }), []);
  assert.strictEqual(JSON.stringify(project), before, 'Shader Graph validation must be non-mutating');
  const inProgress = JSON.parse(JSON.stringify(graph));
  inProgress.nodes.push({ id: 'unconnected-tint', type: 'tint', position: { x: 300, y: 300 }, parameters: {} });
  assert.deepStrictEqual(validateShaderGraphDocument([inProgress], { strict: true }), [], 'disconnected authoring nodes outside the Output-reachable graph may be saved');

  const unknown = JSON.parse(JSON.stringify(graph));
  unknown.nodes.push({ id: 'future', type: 'futureShaderNode', position: { x: 0, y: 0 }, parameters: { extension: true }, extension: 'keep' });
  const compatibleUnknown = validateShaderGraphDocument([unknown]);
  assert(compatibleUnknown.some(item => item.code === 'W_SHADER_NODE_UNKNOWN' && item.severity === 'warning'));
  assert.strictEqual(compatibleUnknown.some(item => item.severity === 'error'), false);
  assert(validateShaderGraphDocument([unknown], { strict: true }).some(item => item.code === 'E_SHADER_NODE_UNKNOWN'));
  const unknownInActiveChain = normalizeShaderGraph({
    id: 'future-chain', name: 'Future Chain', nodes: [
      { id: 'scene', type: 'sceneTexture', position: { x: 0, y: 0 }, parameters: {} },
      { id: 'future', type: 'futureShaderNode', position: { x: 100, y: 0 }, parameters: {} },
      { id: 'output', type: 'output', position: { x: 200, y: 0 }, parameters: {} }
    ], links: [
      { id: 'scene-future', from: { nodeId: 'scene', port: 'color' }, to: { nodeId: 'future', port: 'input' } },
      { id: 'future-output', from: { nodeId: 'future', port: 'result' }, to: { nodeId: 'output', port: 'color' } }
    ], outputNodeId: 'output'
  });
  const compatibleFutureChain = validateShaderGraphDocument([unknownInActiveChain]);
  assert(compatibleFutureChain.some(item => item.code === 'W_SHADER_NODE_UNKNOWN'));
  assert.strictEqual(compatibleFutureChain.some(item => item.severity === 'error'), false, 'future nodes and ports must remain compatible outside strict validation');
  assert(validateShaderGraphDocument([unknownInActiveChain], { strict: true }).some(item => item.code === 'E_SHADER_NODE_UNKNOWN'));

  assert(validateShaderGraphDocument({
    id: 'malformed', name: 'Malformed', version: 1, domain: 'postProcess', nodes: {}, links: [], outputNodeId: 'output'
  }).some(item => item.code === 'E_SHADER_NODES'), 'a malformed standalone graph must not be mistaken for an empty Project');

  const duplicateTarget = JSON.parse(JSON.stringify(graph));
  duplicateTarget.links.push({ id: 'another-output-link', from: { nodeId: 'scene', port: 'color' }, to: { nodeId: 'output', port: 'color' } });
  assert(validateShaderGraphDocument([duplicateTarget]).some(item => item.code === 'E_SHADER_LINK_TARGET_DUPLICATE'));

  const badPort = JSON.parse(JSON.stringify(graph));
  badPort.links[0].from.port = 'missing';
  assert(validateShaderGraphDocument([badPort]).some(item => item.code === 'E_SHADER_LINK_OUTPUT_PORT'));

  const dangling = JSON.parse(JSON.stringify(graph));
  dangling.links[0].from.nodeId = 'missing';
  const danglingDiagnostics = validateShaderGraphDocument([dangling]);
  assert(danglingDiagnostics.some(item => item.code === 'E_SHADER_LINK_NODE_REFERENCE'));
  assert(danglingDiagnostics.some(item => item.code === 'E_SHADER_INPUT_REQUIRED'));

  const invalidOutput = JSON.parse(JSON.stringify(graph));
  invalidOutput.outputNodeId = 'scene';
  assert(validateShaderGraphDocument([invalidOutput]).some(item => item.code === 'E_SHADER_OUTPUT_KIND'));
  invalidOutput.nodes.push({ id: 'output-2', type: 'output', position: { x: 0, y: 0 }, parameters: {} });
  assert(validateShaderGraphDocument([invalidOutput]).some(item => item.code === 'E_SHADER_OUTPUT_COUNT'));

  const cycle = {
    id: 'cycle', name: 'Cycle', version: 1, domain: 'postProcess', outputNodeId: 'output',
    nodes: [
      { id: 'scene', type: 'sceneTexture', position: { x: 0, y: 0 }, parameters: {} },
      { id: 'a', type: 'tint', position: { x: 100, y: 0 }, parameters: {} },
      { id: 'b', type: 'tint', position: { x: 200, y: 0 }, parameters: {} },
      { id: 'output', type: 'output', position: { x: 300, y: 0 }, parameters: {} }
    ],
    links: [
      { id: 'a-b', from: { nodeId: 'a', port: 'color' }, to: { nodeId: 'b', port: 'color' } },
      { id: 'b-a', from: { nodeId: 'b', port: 'color' }, to: { nodeId: 'a', port: 'color' } },
      { id: 'scene-output', from: { nodeId: 'scene', port: 'color' }, to: { nodeId: 'output', port: 'color' } }
    ]
  };
  assert.strictEqual(
    validateShaderGraphDocument([cycle]).some(item => item.code === 'E_SHADER_GRAPH_CYCLE'),
    false,
    'disconnected work-in-progress cycles outside the Output chain may be saved'
  );
  const reachableCycle = JSON.parse(JSON.stringify(cycle));
  reachableCycle.links[2] = { id: 'b-output', from: { nodeId: 'b', port: 'color' }, to: { nodeId: 'output', port: 'color' } };
  assert(validateShaderGraphDocument([reachableCycle]).some(item => item.code === 'E_SHADER_GRAPH_CYCLE'));

  const parameter = normalizeShaderGraph({ name: 'Bad Parameter' });
  parameter.nodes.splice(1, 0, { id: 'pixel', type: 'pixelate', position: { x: 200, y: 0 }, parameters: { size: 0 } });
  parameter.links = [
    { id: 'scene-pixel', from: { nodeId: 'scene', port: 'color' }, to: { nodeId: 'pixel', port: 'color' } },
    { id: 'pixel-output', from: { nodeId: 'pixel', port: 'color' }, to: { nodeId: 'output', port: 'color' } }
  ];
  assert(validateShaderGraphDocument([parameter]).some(item => item.code === 'E_SHADER_PARAMETER_RANGE'));

  for (const [index, color] of ['#abc', '#AbC7', '#aabbcc', '#AABBCC80'].entries()) {
    const validTint = JSON.parse(JSON.stringify(graph));
    validTint.nodes.push({ id: `valid-tint-${index}`, type: 'tint', position: { x: 0, y: 0 }, parameters: { color } });
    assert.strictEqual(
      validateShaderGraphDocument([validTint], { strict: true }).some(item => item.pointer.endsWith(`/parameters/color`) && item.severity === 'error'),
      false,
      `${color} must be accepted by the tint contract`
    );
  }
  for (const [index, color] of ['red', '#12', '#12345', '#ggg', '#123456789'].entries()) {
    const invalidTint = JSON.parse(JSON.stringify(graph));
    invalidTint.nodes.push({ id: `invalid-tint-${index}`, type: 'tint', position: { x: 0, y: 0 }, parameters: { color } });
    assert(validateShaderGraphDocument([invalidTint]).some(item => (
      item.code === 'E_SHADER_PARAMETER_VALUE' && item.pointer.endsWith('/nodes/2/parameters/color')
    )), `${color} must be rejected by the tint contract`);
  }

  const duplicateGraph = { shaderGraphs: [graph, { ...graph }] };
  assert(validateShaderGraphDocument(duplicateGraph).some(item => item.code === 'E_SHADER_GRAPH_ID_DUPLICATE'));
  const missingGraph = { shaderGraphs: [graph], postProcess: { effects: [{ id: 'missing', type: 'shaderGraph', graphId: 'not-there' }] } };
  assert(validateShaderGraphDocument(missingGraph).some(item => item.code === 'E_SHADER_EFFECT_GRAPH_REFERENCE'));
  const missingGraphId = { shaderGraphs: [graph], postProcess: { effects: [{ id: 'missing', type: 'shaderGraph' }] } };
  assert(validateShaderGraphDocument(missingGraphId).some(item => item.code === 'E_SHADER_EFFECT_GRAPH_ID'));

  const postProcessType = validateShaderGraphDocument({ shaderGraphs: [graph], postProcess: [] });
  assert(postProcessType.some(item => item.code === 'E_POST_PROCESS_TYPE' && item.pointer === '/postProcess'));
  const effectsType = validateShaderGraphDocument({ shaderGraphs: [graph], postProcess: { effects: {} } });
  assert(effectsType.some(item => item.code === 'E_POST_PROCESS_EFFECTS_TYPE' && item.pointer === '/postProcess/effects'));
  const missingEffects = validateShaderGraphDocument({ shaderGraphs: [graph], postProcess: { enabled: true } });
  assert(missingEffects.some(item => item.code === 'E_POST_PROCESS_EFFECTS_TYPE' && item.pointer === '/postProcess/effects'));
  const invalidEffects = validateShaderGraphDocument({ shaderGraphs: [graph], postProcess: { effects: [
    null,
    { type: 'vignette' },
    { id: 'missing-type', type: ' ' },
    { id: 'duplicate-effect', type: 'bloom' },
    { id: ' duplicate-effect ', type: 'futureEffect', extension: { keep: true } }
  ] } });
  assert(invalidEffects.some(item => item.code === 'E_POST_PROCESS_EFFECT_OBJECT' && item.pointer === '/postProcess/effects/0'));
  assert(invalidEffects.some(item => item.code === 'E_POST_PROCESS_EFFECT_ID' && item.pointer === '/postProcess/effects/1/id'));
  assert(invalidEffects.some(item => item.code === 'E_POST_PROCESS_EFFECT_TYPE' && item.pointer === '/postProcess/effects/2/type'));
  const duplicateEffect = invalidEffects.find(item => item.code === 'E_POST_PROCESS_EFFECT_ID_DUPLICATE');
  assert.strictEqual(duplicateEffect.pointer, '/postProcess/effects/4/id');
  assert.strictEqual(duplicateEffect.details.firstPointer, '/postProcess/effects/3/id');
  const invalidEffectShape = validateShaderGraphDocument({ shaderGraphs: [graph], postProcess: {
    enabled: null,
    effects: [{ id: 'shape', type: 'vignette', name: 42, enabled: 'yes', graphId: ' ', parameters: [] }]
  } });
  for (const [code, pointer] of [
    ['E_POST_PROCESS_ENABLED', '/postProcess/enabled'],
    ['E_POST_PROCESS_EFFECT_NAME', '/postProcess/effects/0/name'],
    ['E_POST_PROCESS_EFFECT_ENABLED', '/postProcess/effects/0/enabled'],
    ['E_POST_PROCESS_EFFECT_GRAPH_ID', '/postProcess/effects/0/graphId'],
    ['E_POST_PROCESS_EFFECT_PARAMETERS', '/postProcess/effects/0/parameters']
  ]) assert(invalidEffectShape.some(item => item.code === code && item.pointer === pointer), `${code} must point to ${pointer}`);

  const unsafePostProcess = {
    shaderGraphs: [graph],
    postProcess: { enabled: true, effects: [{
      id: 'unsafe', type: 'futureEffect', parameters: { amount: Number.NaN },
      functionExtension: () => {}, objectExtension: new Date(0)
    }] }
  };
  const unsafeDiagnostics = validateShaderGraphDocument(unsafePostProcess);
  assert(unsafeDiagnostics.some(item => item.code === 'E_POST_PROCESS_NUMBER' && item.pointer === '/postProcess/effects/0/parameters/amount'));
  assert(unsafeDiagnostics.some(item => item.code === 'E_POST_PROCESS_JSON_TYPE' && item.pointer === '/postProcess/effects/0/functionExtension'));
  assert(unsafeDiagnostics.some(item => item.code === 'E_POST_PROCESS_JSON_OBJECT' && item.pointer === '/postProcess/effects/0/objectExtension'));
  const circularEffectExtension = {};
  circularEffectExtension.self = circularEffectExtension;
  assert(validateShaderGraphDocument({
    shaderGraphs: [graph],
    postProcess: { effects: [{ id: 'circular', type: 'futureEffect', extension: circularEffectExtension }] }
  }).some(item => item.code === 'E_POST_PROCESS_JSON_CIRCULAR' && item.pointer === '/postProcess/effects/0/extension/self'));
  assert.throws(
    () => assertShaderGraphDocument({ shaderGraphs: [graph], postProcess: { effects: [
      { id: 'same', type: 'vignette' }, { id: 'same', type: 'bloom' }
    ] } }),
    error => error instanceof ComponentSchemaError && error.code === 'E_POST_PROCESS_EFFECT_ID_DUPLICATE' && error.pointer === '/postProcess/effects/1/id'
  );

  const circular = normalizeShaderGraph({ name: 'Circular Extension' });
  circular.nodes[0].future = {};
  circular.nodes[0].future.self = circular.nodes[0].future;
  assert(validateShaderGraphDocument([circular]).some(item => item.code === 'E_SHADER_JSON_CIRCULAR'));
  assert.throws(() => assertShaderGraphDocument([badPort]), error => error instanceof ComponentSchemaError && error.code === 'E_SHADER_LINK_OUTPUT_PORT');
});

test('normalizes, validates, and samples canonical Animation Clips without losing extensions', () => {
  assert.strictEqual(ANIMATION_CLIP_SCHEMA.required.includes('tracks'), true);
  assert.strictEqual(JSON_SCHEMAS.animationClip, ANIMATION_CLIP_SCHEMA);
  const legacy = {
    name: 'Knight Run', fps: 10, frames: 4, loop: true, futureClip: { keep: true },
    events: [{ frame: 2, name: 'Footstep', payload: { foot: 'left' }, futureEvent: 7 }]
  };
  const legacyDiagnostics = validateAnimationDocument({ animations: [legacy] });
  assert(legacyDiagnostics.some(item => item.code === 'W_ANIMATION_LEGACY' && item.pointer === '/animations/0/id'));
  assert.throws(() => assertAnimationDocument({ animations: [legacy] }, { strict: true }), error => error instanceof ComponentSchemaError && error.code === 'E_ANIMATION_LEGACY');
  const normalized = normalizeAnimationClip(legacy, 0);
  assert.strictEqual(normalized.id, 'knight-run');
  assert.strictEqual(normalized.frameCount, 4);
  assert.strictEqual(normalized.futureClip.keep, true);
  assert.strictEqual(normalized.tracks[0].type, 'event');
  assert.strictEqual(normalized.tracks[0].keyframes[0].value.payload.foot, 'left');
  assert.strictEqual(normalized.tracks[0].keyframes[0].futureEvent, 7);

  const clip = {
    id: 'move', name: 'Move', fps: 10, frameCount: 4, loop: false, futureClip: 'preserved',
    tracks: [
      { id: 'position', type: 'position', targetEntityId: 'player', keyframes: [
        { id: 'position-0', frame: 0, value: { x: 0, y: 5, futureValue: true } },
        { id: 'position-3', frame: 3, value: { x: 30, y: 5 } }
      ] },
      { id: 'rotation', type: 'rotation', targetEntityId: 'player', keyframes: [
        { id: 'rotation-0', frame: 0, value: 0 },
        { id: 'rotation-3', frame: 3, value: 90 }
      ] },
      { id: 'custom', type: 'gameplay-custom', keyframes: [{ id: 'custom-1', frame: 1, value: { keep: true } }], futureTrack: 9 }
    ]
  };
  assert.deepStrictEqual(validateAnimationDocument({ animations: [clip], scenes: [{ objects: [{ id: 'player' }] }] }), []);
  assert.doesNotThrow(() => assertAnimationDocument({ animations: [clip], scenes: [{ objects: [{ id: 'player' }] }] }));
  const sample = sampleAnimationClip(clip, 1.5, { unit: 'frame' });
  assert.strictEqual(sample.frame, 1.5);
  assert.strictEqual(sample.frameIndex, 1);
  assert.strictEqual(sample.values.position.x, 15);
  assert.strictEqual(sample.values.position.y, 5);
  assert.strictEqual(sample.values.position.futureValue, true);
  assert.strictEqual(sample.values.rotation, 45);
  assert.deepStrictEqual(sample.values.custom, { keep: true });

  const invalid = JSON.parse(JSON.stringify(clip));
  invalid.tracks[0].keyframes.push({ id: 'position-3', frame: 8, value: { x: 1, y: 2 } });
  const diagnostics = validateAnimationDocument({ animations: [invalid], scenes: [{ objects: [{ id: 'other' }] }] });
  assert(diagnostics.some(item => item.code === 'E_ANIMATION_TARGET_MISSING'));
  assert(diagnostics.some(item => item.code === 'E_ANIMATION_KEYFRAME_ID_DUPLICATE'));
  assert(diagnostics.some(item => item.code === 'E_ANIMATION_KEYFRAME_FRAME'));
});

test('keeps custom Animation track types lossless and removes legacy empty events', () => {
  const normalized = normalizeAnimationClip({
    id: 'extensions', name: 'Extensions', fps: 12, frameCount: 2, loop: true,
    events: [], futureClip: { keep: true },
    tracks: [
      { id: 'shader', type: 'ShaderUniform', interpolation: 'step', futureTrack: true, keyframes: [
        { id: 'shader-0', frame: 0, value: { uniform: 'glow', value: 0.5 } }
      ] },
      { id: 'position', type: 'POSITION', keyframes: [
        { id: 'position-0', frame: 0, value: { x: 1, y: 2 } }
      ] }
    ]
  });
  assert.strictEqual(normalized.tracks[0].type, 'ShaderUniform');
  assert.strictEqual(normalized.tracks[1].type, 'position');
  assert.strictEqual(normalized.futureClip.keep, true);
  assert.strictEqual(normalized.tracks[0].futureTrack, true);
  assert.strictEqual(hasOwn(normalized, 'events'), false);
  assert.strictEqual(sampleAnimationClip(normalized, 0, { unit: 'frame' }).tracks[0].type, 'ShaderUniform');
  assert.deepStrictEqual(validateAnimationDocument({ animations: [normalized] }, { strict: true }), []);
});

test('canonicalizes legacy Sprite frame aliases with canonical precedence', () => {
  const normalized = normalizeAnimationClip({
    id: 'sprite-alias', name: 'Sprite Alias', fps: 12, frameCount: 2, loop: true,
    tracks: [{ id: 'sprite', type: 'sprite', keyframes: [
      { id: 'legacy', frame: 0, value: { spriteFrame: '2', extension: true } },
      { id: 'canonical', frame: 1, value: { frame: 3, spriteFrame: 9 } }
    ] }]
  });
  assert.deepStrictEqual(normalized.tracks[0].keyframes.map(key => key.value.frame), [2, 3]);
  assert.strictEqual(normalized.tracks[0].keyframes[0].value.extension, true);
  assert.strictEqual(hasOwn(normalized.tracks[0].keyframes[0].value, 'spriteFrame'), false);
  assert.strictEqual(hasOwn(normalized.tracks[0].keyframes[1].value, 'spriteFrame'), false);

  const invalid = value => ({
    id: 'invalid-sprite', name: 'Invalid Sprite', fps: 12, frameCount: 1, loop: true,
    tracks: [{ id: 'sprite', type: 'sprite', keyframes: [{ id: 'sprite-0', frame: 0, value }] }]
  });
  assert(validateAnimationDocument([invalid({ frame: -1 })]).some(item => item.code === 'E_ANIMATION_SPRITE_FRAME'));
  assert(validateAnimationDocument([invalid({ frame: 1.5 })]).some(item => item.code === 'E_ANIMATION_SPRITE_FRAME'));
  assert.strictEqual(validateAnimationDocument([invalid({ frame: '2' })]).some(item => item.code === 'E_ANIMATION_SPRITE_FRAME'), false);
  assert(validateAnimationDocument([invalid({ frame: '2' })], { strict: true }).some(item => item.code === 'E_ANIMATION_SPRITE_FRAME'));
});

test('generates deterministic collision-safe IDs for legacy Animation Clip collections', () => {
  const legacy = name => ({ name, fps: 12, frames: 2, loop: true, events: [] });
  const normalized = normalizeAnimationClips([
    legacy('Walk Left'),
    legacy('Walk-Left'),
    legacy('Walk Left'),
    { ...legacy('Explicit'), id: 'walk-left-2' }
  ]);
  assert.deepStrictEqual(
    normalized.map(clip => clip.id),
    ['walk-left', 'walk-left-3', 'walk-left-4', 'walk-left-2'],
    'generated IDs must avoid both earlier generated IDs and every explicit ID in the collection'
  );

  const explicitDuplicates = [
    { ...legacy('First'), id: 'same-id' },
    { ...legacy('Second'), id: 'same-id' }
  ];
  assert.deepStrictEqual(normalizeAnimationClips(explicitDuplicates).map(clip => clip.id), ['same-id', 'same-id']);
  assert(validateAnimationDocument(explicitDuplicates).some(item => item.code === 'E_ANIMATION_CLIP_ID_DUPLICATE'));
});

test('uses exact schema types in strict Animation validation', () => {
  const clip = {
    id: 'numeric-strings', name: 'Numeric Strings', fps: '12', frameCount: '2', speed: '1', loop: false,
    tracks: [{ id: 'position', type: 'position', interpolation: 7, keyframes: [{
      id: 'position-1', frame: '1', easing: 9, value: { x: '1', y: '2' }
    }] }]
  };
  const compatible = validateAnimationDocument({ animations: [clip] });
  assert(compatible.some(item => item.code === 'E_ANIMATION_INTERPOLATION'));
  assert(compatible.some(item => item.code === 'E_ANIMATION_EASING'));
  assert.strictEqual(compatible.some(item => ['E_ANIMATION_FPS', 'E_ANIMATION_FRAME_COUNT', 'E_ANIMATION_SPEED', 'E_ANIMATION_KEYFRAME_FRAME', 'E_ANIMATION_POSITION_VALUE'].includes(item.code)), false);

  const strict = validateAnimationDocument({ animations: [clip] }, { strict: true });
  for (const code of ['E_ANIMATION_FPS', 'E_ANIMATION_FRAME_COUNT', 'E_ANIMATION_SPEED', 'E_ANIMATION_INTERPOLATION', 'E_ANIMATION_KEYFRAME_FRAME', 'E_ANIMATION_EASING', 'E_ANIMATION_POSITION_VALUE']) {
    assert(strict.some(item => item.code === code), `${code} not reported`);
  }
});

test('samples every Event keyframe that shares the exact frame', () => {
  const clip = {
    id: 'simultaneous-events', name: 'Simultaneous Events', fps: 10, frameCount: 2, loop: false,
    tracks: [{ id: 'events', type: 'event', keyframes: [
      { id: 'sound', frame: 1, value: { name: 'Sound', payload: { volume: 0.5 } } },
      { id: 'damage', frame: 1, value: { name: 'Damage', payload: { amount: 4 } } }
    ] }]
  };
  assert.deepStrictEqual(validateAnimationDocument([clip]), []);
  const sample = sampleAnimationClip(clip, 1, { unit: 'frame', loop: false });
  assert.deepStrictEqual(sample.events.map(event => event.keyframeId), ['sound', 'damage']);
  assert.deepStrictEqual(sample.events.map(event => event.name), ['Sound', 'Damage']);
  assert.deepStrictEqual(sample.events[1].payload, { amount: 4 });
});

test('validates Animation targets and clip references across Scenes and Prefabs', () => {
  const clip = { id: 'idle', name: 'Idle', fps: 12, frameCount: 1, loop: true, tracks: [] };
  const missingTarget = { ...clip, id: 'missing-target', targetEntityId: 'ghost' };
  assert(validateAnimationDocument({
    animations: [missingTarget], scenes: [{ id: 'empty', objects: [] }], prefabs: []
  }).some(item => item.code === 'E_ANIMATION_TARGET_MISSING'));

  const document = {
    animations: [clip],
    scenes: [{ id: 'main', objects: [{ id: 'scene-entity', components: { Animation: { clipId: 'missing-scene' } } }] }],
    prefabs: [{ id: 'animated-prefab', rootEntityId: 'source-root', revision: 1, entities: [
      { id: 'source-root', components: { Animation: { clipId: 'missing-prefab' } } }
    ] }]
  };
  const diagnostics = validateAnimationDocument(document);
  assert(diagnostics.some(item => item.code === 'E_ANIMATION_CLIP_REFERENCE' && item.pointer === '/scenes/0/objects/0/components/Animation/clipId'));
  assert(diagnostics.some(item => item.code === 'E_ANIMATION_CLIP_REFERENCE' && item.pointer === '/prefabs/0/entities/0/components/Animation/clipId'));

  document.scenes[0].objects[0].components.Animation.clipId = 'idle';
  document.prefabs[0].entities[0].components.Animation.clipId = 'idle';
  assert.deepStrictEqual(validateAnimationDocument(document), []);
});

test('accepts definition-free v3 Animation snapshots without weakening authoring references', () => {
  const animatedEntity = { id: 'animated', components: { Animation: { clipId: 'run', time: 0.25 } } };
  const snapshot = { format: 'AH2D', version: 3, entities: [animatedEntity] };
  assert.deepStrictEqual(validateAnimationDocument(snapshot, { strict: true }), []);
  assert.doesNotThrow(() => assertAnimationDocument(snapshot, { strict: true }));

  for (const authoringLike of [
    { format: 'AH2D', version: 4, entities: [animatedEntity] },
    { format: 'AH2D', version: 3, entities: [animatedEntity], animations: [] },
    { format: 'AH2D', version: 3, scenes: [{ id: 'main', objects: [animatedEntity] }] }
  ]) {
    assert(
      validateAnimationDocument(authoringLike, { strict: true }).some(item => item.code === 'E_ANIMATION_CLIP_REFERENCE'),
      'only a v3 entities snapshot with no animations field may omit Clip definitions'
    );
  }
});

test('registers canonical Skeleton components and strips only derived pose data from authoring', () => {
  const registry = createDefaultComponentRegistry();
  assert.deepStrictEqual(registry.create('Skeleton'), { enabled: true, solveIK: true, debug: false });
  assert.deepStrictEqual(registry.create('Bone'), { length: 32, inheritRotation: true, inheritScale: true });
  const skeleton = {
    rootBoneId: 'hip', enabled: true, solveIK: true, debug: false,
    pose: { hip: { rotation: 10 } }, boneMatrices: { hip: [1, 0, 0, 1, 4, 8] },
    extension: { keep: true }
  };
  assert.deepStrictEqual(registry.normalize('Skeleton', skeleton, { profile: 'authoring' }), {
    rootBoneId: 'hip', enabled: true, solveIK: true, debug: false, extension: { keep: true }
  });
  assert.deepStrictEqual(registry.normalize('Skeleton', skeleton, { profile: 'runtime' }).boneMatrices.hip, [1, 0, 0, 1, 4, 8]);
  const skin = {
    skeletonRootId: 'rig', vertices: [], deformedVertices: [{ x: 2, y: 3 }], extension: true
  };
  assert.strictEqual(registry.normalize('Skin', skin, { profile: 'authoring' }).deformedVertices, undefined);
  assert.deepStrictEqual(registry.normalize('Skin', skin, { profile: 'runtime' }).deformedVertices, [{ x: 2, y: 3 }]);
  assert.strictEqual(registry.normalize('Skin', skin, { profile: 'authoring' }).extension, true);
  assert.strictEqual(registry.describe('IK').schemas.authoring.required.includes('skeletonRootId'), true);
  assert.strictEqual(registry.describe('Skin').schemas.authoring.required.includes('vertices'), true);
});

test('validates Skeleton, Bone, IK, and Skin references independently in every Scene and Prefab scope', () => {
  const rigEntities = prefix => [
    { id: `${prefix}-rig`, components: { Skeleton: { rootBoneId: `${prefix}-hip`, enabled: true, futureSkeleton: true } } },
    { id: `${prefix}-hip`, parentId: `${prefix}-rig`, components: { Bone: { length: 40, color: '#fff', futureBone: 1 } } },
    { id: `${prefix}-knee`, parentId: `${prefix}-hip`, components: { Bone: { length: 32 } } },
    { id: `${prefix}-target`, components: { IK: {
      id: `${prefix}-leg-ik`, skeletonRootId: `${prefix}-rig`, bones: [`${prefix}-hip`, `${prefix}-knee`],
      mix: 1, iterations: 12, tolerance: 0.01, enabled: true, bendDirection: 1, futureIK: true
    } } },
    { id: `${prefix}-mesh`, components: { Skin: {
      skeletonRootId: `${prefix}-rig`, assetId: `${prefix}-texture`,
      vertices: [
        { x: 0, y: 0, weights: [{ boneId: `${prefix}-hip`, weight: 0.25 }, { boneId: `${prefix}-knee`, weight: 0.75 }] },
        { x: 10, y: 0, weights: [{ boneId: `${prefix}-knee`, weight: 1 }] }
      ],
      uvs: [0, 0, 1, 0], indices: [0, 1, 0], futureSkin: { keep: true }
    } } }
  ];
  const document = {
    scenes: [{ id: 'main', objects: rigEntities('scene') }],
    prefabs: [{ id: 'knight', rootEntityId: 'prefab-rig', entities: rigEntities('prefab') }]
  };
  assert.deepStrictEqual(validateSkeletonDocument(document), []);
  assert.doesNotThrow(() => assertSkeletonDocument(document));
  assert.deepStrictEqual(validateSkeletonDocument({ entities: [
    { id: 'combined-root', components: { Skeleton: {}, Bone: { length: 12 } } },
    { id: 'combined-child', parentId: 'combined-root', components: { Bone: { length: 8 } } }
  ] }), [], 'a Skeleton Entity may also be its root Bone, matching Runtime composition');

  const crossScope = JSON.parse(JSON.stringify(document));
  crossScope.scenes[0].objects[3].components.IK.bones[1] = 'prefab-knee';
  const crossDiagnostics = validateSkeletonDocument(crossScope);
  assert(crossDiagnostics.some(item => item.code === 'E_IK_BONE_REFERENCE' && item.pointer === '/scenes/0/objects/3/components/IK/bones/1'));

  const invalid = JSON.parse(JSON.stringify(document));
  invalid.scenes[0].objects[0].components.Skeleton.rootBoneId = 'missing-root';
  invalid.scenes[0].objects.push({ id: 'orphan', components: { Bone: { length: 1 } } });
  invalid.scenes[0].objects[3].components.IK.bones = ['scene-hip', 'scene-hip'];
  invalid.scenes[0].objects[4].components.Skin.vertices[0].weights = [
    { boneId: 'scene-knee', weight: 0 },
    { boneId: 'scene-knee', weight: 0 },
    { boneId: 'missing-bone', weight: 0 }
  ];
  const diagnostics = validateSkeletonDocument(invalid);
  for (const code of [
    'E_SKELETON_ROOT_BONE_REFERENCE', 'E_BONE_SKELETON_ANCESTRY', 'E_IK_BONE_DUPLICATE',
    'E_IK_CHAIN', 'E_SKIN_BONE_DUPLICATE', 'E_SKIN_BONE_REFERENCE', 'E_SKIN_WEIGHT_TOTAL'
  ]) assert(diagnostics.some(item => item.code === code), `${code} not reported`);
  assert.throws(
    () => assertSkeletonDocument(invalid),
    error => error instanceof ComponentSchemaError && error.diagnostics.some(item => item.code === 'E_SKIN_WEIGHT_TOTAL')
  );
});

test('accepts definition-free v3 Skeleton snapshots without weakening authoring references', () => {
  const runtimeEntities = [
    { id: 'instance-rig', components: { Skeleton: {
      rootBoneId: 'source-hip', pose: { 'source-hip': { rotation: 15 } },
      boneMatrices: { 'source-hip': [1, 0, 0, 1, 5, 6] }
    } } },
    { id: 'instance-target', components: { IK: { skeletonRootId: 'source-rig', bones: ['source-hip'] } } },
    { id: 'instance-mesh', components: { Skin: {
      skeletonRootId: 'source-rig', vertices: [{ x: 0, y: 0, weights: [{ boneId: 'source-hip', weight: 1 }] }],
      deformedVertices: [{ x: 5, y: 6 }]
    } } }
  ];
  const snapshot = { format: 'AH2D', version: 3, entities: runtimeEntities };
  assert.deepStrictEqual(validateSkeletonDocument(snapshot, { strict: true }), []);
  assert.doesNotThrow(() => assertSkeletonDocument(snapshot, { strict: true }));

  for (const authoringLike of [
    { format: 'AH2D', version: 4, entities: runtimeEntities },
    { format: 'AH2D', version: 3, entities: runtimeEntities, prefabs: [] },
    { format: 'AH2D', version: 3, scenes: [{ id: 'main', objects: runtimeEntities }] }
  ]) {
    assert(
      validateSkeletonDocument(authoringLike, { strict: true }).some(item => item.code === 'E_IK_SKELETON_REFERENCE'),
      'only a definition-free v3 entities snapshot may omit authoring Skeleton references'
    );
  }
});

test('resolves Skeleton references independently inside multiple expanded Prefab instances', () => {
  const marker = (instanceRootId, sourceEntityId) => ({
    prefabId: 'rig-prefab', sourceEntityId, instanceRootId, prefabRevision: 1, overrides: {}
  });
  const instance = prefix => [
    { id: `${prefix}-rig`, components: {
      PrefabInstance: marker(`${prefix}-rig`, 'source-rig'),
      Skeleton: { rootBoneId: 'source-hip' }
    } },
    { id: `${prefix}-hip`, parentId: `${prefix}-rig`, components: {
      PrefabInstance: marker(`${prefix}-rig`, 'source-hip'), Bone: { length: 20 }
    } },
    { id: `${prefix}-knee`, parentId: `${prefix}-hip`, components: {
      PrefabInstance: marker(`${prefix}-rig`, 'source-knee'), Bone: { length: 16 }
    } },
    { id: `${prefix}-target`, components: {
      PrefabInstance: marker(`${prefix}-rig`, 'source-target'),
      IK: { skeletonRootId: 'source-rig', bones: ['source-hip', 'source-knee'] }
    } },
    { id: `${prefix}-mesh`, components: {
      PrefabInstance: marker(`${prefix}-rig`, 'source-mesh'),
      Skin: { skeletonRootId: 'source-rig', vertices: [{
        x: 0, y: 0, weights: [{ boneId: 'source-knee', weight: 1 }]
      }] }
    } }
  ];
  const document = { scenes: [{ id: 'main', objects: [...instance('a'), ...instance('b')] }] };
  assert.deepStrictEqual(validateSkeletonDocument(document), []);

  const broken = JSON.parse(JSON.stringify(document));
  broken.scenes[0].objects.find(entity => entity.id === 'b-knee').components.PrefabInstance.sourceEntityId = 'different-source';
  const diagnostics = validateSkeletonDocument(broken);
  assert(diagnostics.some(item => item.code === 'E_IK_BONE_REFERENCE' && item.pointer === '/scenes/0/objects/8/components/IK/bones/1'));
  assert(diagnostics.some(item => item.code === 'E_SKIN_BONE_REFERENCE' && item.pointer === '/scenes/0/objects/9/components/Skin/vertices/0/weights/0/boneId'));
  assert.strictEqual(
    diagnostics.some(item => item.pointer.startsWith('/scenes/0/objects/3/') || item.pointer.startsWith('/scenes/0/objects/4/')),
    false,
    'a broken second instance must not poison the first instance group'
  );

  const crossInstance = JSON.parse(JSON.stringify(document));
  crossInstance.scenes[0].objects[5].components.Skeleton.rootBoneId = 'a-hip';
  crossInstance.scenes[0].objects[8].components.IK.bones[1] = 'a-knee';
  crossInstance.scenes[0].objects[9].components.Skin.vertices[0].weights[0].boneId = 'a-knee';
  const crossInstanceDiagnostics = validateSkeletonDocument(crossInstance);
  assert(crossInstanceDiagnostics.some(item => item.code === 'E_SKELETON_ROOT_BONE_REFERENCE' && item.pointer === '/scenes/0/objects/5/components/Skeleton/rootBoneId'));
  assert(crossInstanceDiagnostics.some(item => item.code === 'E_IK_BONE_REFERENCE' && item.pointer === '/scenes/0/objects/8/components/IK/bones/1'));
  assert(crossInstanceDiagnostics.some(item => item.code === 'E_SKIN_BONE_REFERENCE' && item.pointer === '/scenes/0/objects/9/components/Skin/vertices/0/weights/0/boneId'));
});

test('rejects malformed Skin topology while allowing an explicitly empty mesh', () => {
  const base = {
    entities: [
      { id: 'rig', components: { Skeleton: { rootBoneId: 'bone' } } },
      { id: 'bone', parentId: 'rig', components: { Bone: { length: 10 } } },
      { id: 'mesh', components: { Skin: { skeletonRootId: 'rig', vertices: [], uvs: [], indices: [] } } }
    ]
  };
  assert.deepStrictEqual(validateSkeletonDocument(base), [], 'empty vertices, uvs, and indices form a valid empty mesh');

  const malformed = JSON.parse(JSON.stringify(base));
  malformed.entities[2].components.Skin.vertices = [
    { x: 0, y: 0, weights: [{ boneId: 'bone', weight: 1 }] },
    { x: 10, y: 0, weights: [{ boneId: 'bone', weight: 1 }] }
  ];
  malformed.entities[2].components.Skin.uvs = [0, 0];
  malformed.entities[2].components.Skin.indices = [0, 2, 1, 0];
  const diagnostics = validateSkeletonDocument(malformed);
  assert(diagnostics.some(item => item.code === 'E_SKIN_UV_COUNT' && item.pointer === '/entities/2/components/Skin/uvs'));
  assert(diagnostics.some(item => item.code === 'E_SKIN_INDEX_COUNT' && item.pointer === '/entities/2/components/Skin/indices'));
  assert(diagnostics.some(item => item.code === 'E_SKIN_INDEX_RANGE' && item.pointer === '/entities/2/components/Skin/indices/1'));
});

test('keeps nested Skeleton ownership as a hard IK and Skin boundary', () => {
  const document = { entities: [
    { id: 'outer-rig', components: { Skeleton: { rootBoneId: 'outer-bone' } } },
    { id: 'outer-bone', parentId: 'outer-rig', components: { Bone: { length: 20 } } },
    { id: 'inner-rig', parentId: 'outer-bone', components: { Skeleton: { rootBoneId: 'inner-bone' } } },
    { id: 'inner-bone', parentId: 'inner-rig', components: { Bone: { length: 10 } } },
    { id: 'outer-target', components: { IK: { skeletonRootId: 'outer-rig', bones: ['inner-bone'] } } },
    { id: 'outer-mesh', components: { Skin: {
      skeletonRootId: 'outer-rig', vertices: [{ x: 0, y: 0, weights: [{ boneId: 'inner-bone', weight: 1 }] }]
    } } }
  ] };
  const diagnostics = validateSkeletonDocument(document);
  assert(diagnostics.some(item => item.code === 'E_IK_BONE_ANCESTRY' && item.pointer === '/entities/4/components/IK/bones/0'));
  assert(diagnostics.some(item => item.code === 'E_SKIN_BONE_ANCESTRY' && item.pointer === '/entities/5/components/Skin/vertices/0/weights/0/boneId'));
});

test('treats a nested co-located Skeleton and Bone as its own root boundary', () => {
  const document = { entities: [
    { id: 'outer-rig', components: { Skeleton: { rootBoneId: 'outer-bone' } } },
    { id: 'outer-bone', parentId: 'outer-rig', components: { Bone: { length: 20 } } },
    { id: 'inner-root', parentId: 'outer-rig', components: {
      Skeleton: { rootBoneId: 'inner-root' }, Bone: { length: 10 }
    } },
    { id: 'inner-child', parentId: 'inner-root', components: { Bone: { length: 8 } } },
    { id: 'inner-target', components: { IK: { skeletonRootId: 'inner-root', bones: ['inner-root', 'inner-child'] } } },
    { id: 'inner-mesh', components: { Skin: {
      skeletonRootId: 'inner-root', vertices: [{ x: 0, y: 0, weights: [{ boneId: 'inner-root', weight: 1 }] }]
    } } }
  ] };
  assert.deepStrictEqual(validateSkeletonDocument(document), [], 'the nested root Bone belongs to its co-located Skeleton, not the outer rig');

  const claimedByOuter = JSON.parse(JSON.stringify(document));
  claimedByOuter.entities[0].components.Skeleton.rootBoneId = 'inner-root';
  const diagnostics = validateSkeletonDocument(claimedByOuter);
  assert(diagnostics.some(item => item.code === 'E_SKELETON_ROOT_BONE_ANCESTRY' && item.pointer === '/entities/0/components/Skeleton/rootBoneId'));
});

test('normalizes, validates, and interpolates Bone and IK Animation tracks', () => {
  const clip = normalizeAnimationClip({
    id: 'rig-motion', name: 'Rig Motion', fps: 12, frameCount: 3, loop: false, futureClip: true,
    tracks: [
      { id: 'hip', type: 'BONE', targetEntityId: 'hip', futureTrack: true, keyframes: [
        { id: 'hip-0', frame: 0, value: { x: '0', rotation: 0, scaleX: 1, futureValue: 4 } },
        { id: 'hip-2', frame: 2, value: { x: 10, rotation: 90, scaleX: 2 } }
      ] },
      { id: 'leg-ik', type: 'IK', targetEntityId: 'target', keyframes: [
        { id: 'ik-0', frame: 0, value: { x: 0, y: 5, mix: '0', enabled: true, bendDirection: 1 } },
        { id: 'ik-2', frame: 2, value: { x: 20, y: 15, mix: 1, enabled: false, bendDirection: -1 } }
      ] }
    ]
  });
  assert.deepStrictEqual(clip.tracks.map(track => track.type), ['bone', 'ik']);
  assert.deepStrictEqual(clip.tracks.map(track => track.interpolation), ['linear', 'linear']);
  assert.strictEqual(clip.tracks[0].keyframes[0].value.x, 0);
  assert.strictEqual(clip.tracks[1].keyframes[0].value.mix, 0);
  assert.strictEqual(clip.tracks[0].futureTrack, true);
  assert.deepStrictEqual(validateAnimationDocument({
    animations: [clip], scenes: [{ objects: [
      { id: 'hip', components: { Bone: { length: 10 } } },
      { id: 'target', components: { IK: {} } }
    ] }]
  }, { strict: true }), []);
  const sample = sampleAnimationClip(clip, 1, { unit: 'frame', loop: false });
  assert.strictEqual(sample.values.hip.x, 5);
  assert.strictEqual(sample.values.hip.rotation, 45);
  assert.strictEqual(sample.values.hip.scaleX, 1.5);
  assert.strictEqual(sample.values.hip.futureValue, 4);
  assert.strictEqual(sample.values['leg-ik'].x, 10);
  assert.strictEqual(sample.values['leg-ik'].y, 10);
  assert.strictEqual(sample.values['leg-ik'].mix, 0.5);
  assert.strictEqual(sample.values['leg-ik'].enabled, true, 'discrete IK values remain on the left key');

  const invalidValue = (type, value) => ({
    id: `${type}-invalid`, name: 'Invalid', fps: 12, frameCount: 1, loop: false,
    tracks: [{ id: type, type, keyframes: [{ id: `${type}-0`, frame: 0, value }] }]
  });
  assert(validateAnimationDocument([invalidValue('bone', { extensionOnly: true })]).some(item => item.code === 'E_ANIMATION_BONE_VALUE'));
  assert(validateAnimationDocument([invalidValue('bone', { rotation: 'bad' })]).some(item => item.code === 'E_ANIMATION_BONE_VALUE'));
  assert(validateAnimationDocument([invalidValue('ik', { mix: 2 })]).some(item => item.code === 'E_ANIMATION_IK_VALUE'));
  assert(validateAnimationDocument([invalidValue('ik', { enabled: 'yes' })]).some(item => item.code === 'E_ANIMATION_IK_VALUE'));
  assert(validateAnimationDocument([invalidValue('ik', { iterations: 0 })]).some(item => item.code === 'E_ANIMATION_IK_VALUE'));
});

test('requires Bone and IK Animation targets to own their matching ECS components', () => {
  const clip = {
    id: 'typed-targets', name: 'Typed Targets', fps: 12, frameCount: 1, loop: false,
    tracks: [
      { id: 'bone', type: 'bone', targetEntityId: 'ordinary-bone-target', keyframes: [{ id: 'bone-0', frame: 0, value: { rotation: 10 } }] },
      { id: 'ik', type: 'ik', targetEntityId: 'ordinary-ik-target', keyframes: [{ id: 'ik-0', frame: 0, value: { mix: 1 } }] },
      { id: 'missing', type: 'bone', targetEntityId: 'missing-target', keyframes: [{ id: 'missing-0', frame: 0, value: { x: 0 } }] }
    ]
  };
  const document = { animations: [clip], scenes: [{ objects: [
    { id: 'ordinary-bone-target' }, { id: 'ordinary-ik-target' }
  ] }] };
  const diagnostics = validateAnimationDocument(document);
  assert(diagnostics.some(item => item.code === 'E_ANIMATION_BONE_TARGET' && item.pointer === '/animations/0/tracks/0/targetEntityId'));
  assert(diagnostics.some(item => item.code === 'E_ANIMATION_IK_TARGET' && item.pointer === '/animations/0/tracks/1/targetEntityId'));
  assert(diagnostics.some(item => item.code === 'E_ANIMATION_TARGET_MISSING' && item.pointer === '/animations/0/tracks/2/targetEntityId'));
  assert.strictEqual(diagnostics.some(item => item.code === 'E_ANIMATION_BONE_TARGET' && item.pointer === '/animations/0/tracks/2/targetEntityId'), false);

  const sourceTarget = JSON.parse(JSON.stringify(clip));
  sourceTarget.tracks = [
    { id: 'source-bone-track', type: 'bone', targetEntityId: 'source-bone', keyframes: [{ id: 'source-bone-0', frame: 0, value: { rotation: 5 } }] },
    { id: 'source-ik-track', type: 'ik', targetEntityId: 'source-target', keyframes: [{ id: 'source-ik-0', frame: 0, value: { x: 5 } }] }
  ];
  const marker = sourceEntityId => ({ prefabId: 'rig', instanceRootId: 'instance-root', sourceEntityId });
  assert.deepStrictEqual(validateAnimationDocument({ animations: [sourceTarget], scenes: [{ objects: [
    { id: 'instance-bone', components: { PrefabInstance: marker('source-bone'), Bone: { length: 10 } } },
    { id: 'instance-target', components: { PrefabInstance: marker('source-target'), IK: {} } }
  ] }] }), []);
});

test('resolves bound Animation targets only inside the exact Prefab instance group', () => {
  const marker = (instanceRootId, sourceEntityId) => ({ prefabId: 'rig', instanceRootId, sourceEntityId });
  const clip = {
    id: 'rig-pose', name: 'Rig Pose', fps: 12, frameCount: 1, loop: true,
    tracks: [
      { id: 'bone', type: 'bone', targetEntityId: 'source-bone', keyframes: [{ id: 'bone-0', frame: 0, value: { rotation: 5 } }] },
      { id: 'ik', type: 'ik', targetEntityId: 'source-target', keyframes: [{ id: 'ik-0', frame: 0, value: { mix: 1 } }] }
    ]
  };
  const validInstance = prefix => [
    { id: `${prefix}-root`, components: {
      PrefabInstance: marker(`${prefix}-root`, 'source-root'), Animation: { clipId: 'rig-pose' }
    } },
    { id: `${prefix}-bone`, components: {
      PrefabInstance: marker(`${prefix}-root`, 'source-bone'), Bone: { length: 10 }
    } },
    { id: `${prefix}-target`, components: {
      PrefabInstance: marker(`${prefix}-root`, 'source-target'), IK: {}
    } }
  ];
  const document = { animations: [clip], scenes: [{ objects: [...validInstance('a'), ...validInstance('b')] }] };
  assert.deepStrictEqual(validateAnimationDocument(document), []);

  const missingInSecondInstance = JSON.parse(JSON.stringify(document));
  missingInSecondInstance.scenes[0].objects[4].components.PrefabInstance.sourceEntityId = 'other-bone';
  const missingDiagnostics = validateAnimationDocument(missingInSecondInstance);
  assert(missingDiagnostics.some(item => item.code === 'E_ANIMATION_TARGET_MISSING' &&
    item.pointer === '/animations/0/tracks/0/targetEntityId' && item.details.animationEntityId === 'b-root'));
  assert.strictEqual(missingDiagnostics.some(item => item.code === 'E_ANIMATION_TARGET_MISSING' &&
    item.details?.animationEntityId === 'a-root'), false, 'the valid first instance remains independently resolvable');

  const wrongTypeInSecondInstance = JSON.parse(JSON.stringify(document));
  delete wrongTypeInSecondInstance.scenes[0].objects[4].components.Bone;
  const wrongTypeDiagnostics = validateAnimationDocument(wrongTypeInSecondInstance);
  assert(wrongTypeDiagnostics.some(item => item.code === 'E_ANIMATION_BONE_TARGET' &&
    item.pointer === '/animations/0/tracks/0/targetEntityId' && item.details.animationEntityId === 'b-root'));
  assert.strictEqual(wrongTypeDiagnostics.some(item => item.code === 'E_ANIMATION_BONE_TARGET' &&
    item.details?.animationEntityId === 'a-root'), false);
});

test('open-world behavior can be disabled and component names remain safe', () => {
  const open = createDefaultComponentRegistry();
  assert.strictEqual(open.resolve('Health'), 'Health');
  assert.strictEqual(open.resolve('health'), null);
  assert.strictEqual(open.resolve('Constructor'), null);
  assert.strictEqual(open.resolve('__proto__'), null);
  assert.strictEqual(DataModel.isSafeComponentName(' Transform '), false);
  const spacedDiagnostics = createDefaultEntityCodec().validate({ id: 'spaced-key', components: { ' Transform ': { x: 1 } } });
  assert(spacedDiagnostics.some(item => item.code === 'E_COMPONENT_NAME' && item.pointer === '/components/ Transform '));

  const closed = createDefaultComponentRegistry({ openWorld: false });
  assert.strictEqual(closed.resolve('Health'), null);
  assert.deepStrictEqual(closed.validate('Health', {}), [
    { severity: 'error', code: 'E_COMPONENT_NAME', message: 'Invalid or unknown Component name: Health', pointer: '' }
  ]);
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

let failures = 0;
for (const { name, run } of tests) {
  try {
    run();
    process.stdout.write(`\u2714 ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`\u2716 ${name}\n${error && error.stack ? error.stack : error}\n`);
  }
}

if (failures) {
  process.stderr.write(`AH2D data-model tests failed: ${failures}/${tests.length}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`AH2D data-model tests passed: ${tests.length}\n`);
}
