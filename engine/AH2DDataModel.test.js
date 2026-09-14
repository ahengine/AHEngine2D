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
  assertAnimationDocument
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
  assert.deepStrictEqual(PREFAB_OVERRIDE_OPERATIONS, ['add', 'replace', 'remove']);

  const source = fs.readFileSync(path.join(__dirname, 'AH2DDataModel.js'), 'utf8');
  const browser = {};
  vm.runInNewContext(source, browser, { filename: 'AH2DDataModel.js' });
  assert.strictEqual(browser.AH2DDataModel.DATA_MODEL_ID, 'ah2d.ecs');
  assert.strictEqual(typeof browser.AH2DDataModel.createDefaultEntityCodec, 'function');
  assert.strictEqual(typeof browser.AH2DDataModel.validatePrefabDocument, 'function');
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
    'Camera', 'Light', 'ShadowCaster', 'Animation', 'Tilemap', 'ParticleEmitter',
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
