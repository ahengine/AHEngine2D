'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('./ah2d.js');
const { createProject, documentHash, validateDocument, listEntities, applyOperations } = require('./AH2DProject.js');

function run(args) {
  let stdout = '', stderr = '';
  const io = { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } };
  const exitCode = main(args, io);
  let payload = null;
  const source = stdout.trim() || stderr.trim();
  if (source) payload = JSON.parse(source);
  return { exitCode, stdout, stderr, payload };
}

function runText(args) {
  let stdout = '', stderr = '';
  const io = { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } };
  const exitCode = main(args, io);
  return { exitCode, stdout, stderr };
}

function success(args) {
  const result = run(args);
  assert.strictEqual(result.exitCode, 0, `command failed: ${args.join(' ')}\n${result.stderr}`);
  assert.strictEqual(result.payload.ok, true);
  assert.strictEqual(result.payload.protocol, 'ah2d.cli/v1');
  return result.payload;
}

function failure(args, code) {
  const result = run(args);
  assert.notStrictEqual(result.exitCode, 0, `command unexpectedly succeeded: ${args.join(' ')}`);
  assert.strictEqual(result.payload.ok, false);
  assert.strictEqual(result.payload.error.code, code);
  return result;
}

function assertMatrixClose(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, message);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-8, (message || 'matrix mismatch') + ' at index ' + index + ': ' + value + ' !== ' + expected[index]));
}


const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ah2d-cli-test-'));
const projectFile = path.join(tempRoot, 'Agent Project.ah2d.json');

try {
  const capabilities = success(['capabilities']).data;
  assert.ok(capabilities.commands.scene.includes('create'));
  assert.ok(capabilities.commands.topLevel.includes('apply'));
  assert.strictEqual(capabilities.mutationSafety.atomicReplace, true);
  assert.strictEqual(capabilities.selectors.unparent, '--root');
  assert.deepStrictEqual(capabilities.dataModel, { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 });
  assert.strictEqual(capabilities.componentSchemas.version, 1);
  assert.deepStrictEqual(capabilities.componentSchemas.profiles, ['authoring', 'runtime', 'snapshot']);
  assert.strictEqual(capabilities.componentSchemas.unknownComponents, 'preserve');
  assert.strictEqual(capabilities.componentSchemas.precedence, 'components');
  assert.ok(capabilities.componentSchemas.types.includes('Transform'));
  assert.ok(capabilities.componentSchemas.types.includes('Rigidbody'));
  assert.strictEqual(capabilities.sceneGraph.authoringTransformSpace, 'local');
  assert.strictEqual(capabilities.sceneGraph.reparentDefault, 'preserve-local');
  assert.strictEqual(capabilities.sceneGraph.reparentModes.preserveWorld, '--preserve-world');
  assert.strictEqual(capabilities.sceneGraph.treeOutput.includeWorld, '--world');
  assert.ok(capabilities.commands.entity.includes('tree'));
  assert.deepStrictEqual(capabilities.enums.physicsBackend, ['box2d', 'builtin']);
  assert.strictEqual(capabilities.options.physicsBackend.flag, '--backend');
  assert.deepStrictEqual(capabilities.options.physicsBackend.values, ['box2d', 'builtin']);
  assert.deepStrictEqual(capabilities.options.physicsBackend.commands, ['physics set', 'validate --engine', 'simulate', 'ecs export']);
  assert.ok(capabilities.commands.prefab.includes('asset create'));
  assert.ok(capabilities.commands.prefab.includes('override apply'));
  assert.deepStrictEqual(capabilities.prefabs.overrideOps, ['add', 'replace', 'remove']);
  assert.deepStrictEqual(capabilities.prefabs.placement.root, ['parentId', 'Transform']);
  assert.strictEqual(capabilities.prefabs.expandedInstances, true);
  assert.strictEqual(capabilities.prefabs.connectedMutationPolicy.structural, 'unpack-required');
  assert.strictEqual(capabilities.prefabs.connectedMutationPolicy.properties, 'prefab override set');
  assert.ok(capabilities.prefabs.connectedMutationPolicy.rootPlacement.includes('entity reparent'));
  assert.strictEqual(capabilities.prefabs.overrideSynchronization.orphanedDescendants, 'promote-to-changed-ancestor');
  assert.strictEqual(capabilities.prefabs.overrideSynchronization.arrayIndexes, 'reindex-or-promote-array');
  assert.strictEqual(capabilities.prefabs.overrideSynchronization.staleInstanceGroups, 'skip');
  assert.strictEqual(capabilities.prefabs.componentContainerSynthesis, 'direct /components/<Type> add only');
  assert.ok(capabilities.prefabs.operations.includes('prefab.unpack'));
  assert.deepStrictEqual(capabilities.enums.animationTrackType, ['sprite', 'position', 'rotation', 'event', 'hitbox']);
  assert.strictEqual(capabilities.animations.schema, 'animationClip');
  assert.strictEqual(capabilities.animations.stableReference, 'clipId');


  const schemaIndex = success(['schema', 'list']).data;
  assert.deepStrictEqual(schemaIndex.schemas, ['project', 'prefabAsset', 'animationClip', 'operation', 'batch']);
  assert.ok(schemaIndex.components.includes('Collider'));
  const transformSchema = success(['schema', 'show', '--component', 'Transform']).data;
  assert.strictEqual(transformSchema.name, 'component:Transform');
  assert.strictEqual(transformSchema.component.type, 'Transform');
  assert.strictEqual(transformSchema.component.schemas.authoring.properties.scaleX.type, 'number');
  const aliasedSchema = success(['schema', 'show', 'component:Body']).data;
  assert.strictEqual(aliasedSchema.name, 'component:Rigidbody');
  assert.strictEqual(aliasedSchema.component.type, 'Rigidbody');
  const projectSchema = success(['schema', 'show', '--name', 'project']).data.schema;
  assert.strictEqual(projectSchema.title, 'AH2D Project');
  assert.deepStrictEqual(projectSchema.$defs.entity.properties.parentId.type, ['string', 'null']);
  assert.ok(projectSchema.$defs.entity.properties.x.description.includes('Local'));
  assert.strictEqual(projectSchema.properties.prefabs.items.$ref, '#/$defs/prefabAsset');
  assert.strictEqual(projectSchema.properties.animations.items.$ref, '#/$defs/animationClip');
  const prefabAssetSchema = success(['schema', 'show', '--name', 'prefabAsset']).data.schema;
  assert.deepStrictEqual(prefabAssetSchema.required, ['id', 'rootEntityId', 'entities']);
  const animationClipSchema = success(['schema', 'show', '--name', 'animationClip']).data.schema;
  assert.deepStrictEqual(animationClipSchema.required, ['id', 'name', 'fps', 'frameCount', 'loop', 'tracks']);


  const initialized = success(['init', '--file', projectFile, '--name', 'Agent Test']).data;
  assert.strictEqual(initialized.created, true);
  assert.ok(fs.existsSync(projectFile));
  let project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.strictEqual(project.format, 'AH2D');
  assert.strictEqual(project.version, 4);
  assert.deepStrictEqual(project.dataModel, { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 });
  assert.strictEqual(project.scenes.length, 1);
  assert.strictEqual(project.engine.physics, 'box2d');
  assert.strictEqual(project.engine.physicsBackend, 'box2d');
  assert.strictEqual(project.engine.physicsImplementation, 'planck');
  assert.ok(project.postProcess.effects.some(effect => effect.type === 'bloom'));
  assert.ok(project.postProcess.effects.some(effect => effect.type === 'crt'));
  const clip = {
    id: 'idle', name: 'Idle', fps: 12, frameCount: 2, loop: true, futureClip: { keep: true },
    tracks: [{ id: 'sprite', type: 'sprite', keyframes: [{ id: 'sprite-0', frame: 0, value: { frame: 0, futureValue: true } }] }]
  };
  const animationDryRun = success(['resource', 'put', '--file', projectFile, 'animation', '--value', JSON.stringify(clip), '--dry-run', '--include-document']).data.document;
  assert.strictEqual(animationDryRun.animations[0].futureClip.keep, true);
  assert.strictEqual(animationDryRun.animations[0].tracks[0].keyframes[0].value.futureValue, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(projectFile, 'utf8')).animations.length, 0, 'Animation dry-run must not mutate the Project');
  success(['resource', 'put', '--file', projectFile, 'animation', '--value', JSON.stringify(clip), '--write']);
  assert.strictEqual(success(['resource', 'get', '--file', projectFile, 'animation', 'idle']).data.value.name, 'Idle');

  const invalidAnimationFile = path.join(tempRoot, 'invalid-animation.ah2d.json');
  const invalidAnimationProject = createProject();
  invalidAnimationProject.animations = [{ ...clip, tracks: [{ id: 'sprite', type: 'sprite', keyframes: [{ id: 'bad', frame: 2, value: { frame: 2 } }] }] }];
  fs.writeFileSync(invalidAnimationFile, JSON.stringify(invalidAnimationProject));
  assert.ok(failure(['validate', '--file', invalidAnimationFile], 'E_PROJECT_INVALID').payload.diagnostics.some(item => item.code === 'E_ANIMATION_KEYFRAME_FRAME'));

  const legacyAnimationFile = path.join(tempRoot, 'legacy-animation.ah2d.json');
  const legacyAnimationProject = createProject();
  legacyAnimationProject.animations = [{ name: 'Legacy', fps: 12, frames: 2, loop: true, events: [{ frame: 1, name: 'Event' }] }];
  fs.writeFileSync(legacyAnimationFile, JSON.stringify(legacyAnimationProject));
  assert.ok(success(['validate', '--file', legacyAnimationFile]).diagnostics.some(item => item.code === 'W_ANIMATION_LEGACY'));
  assert.ok(failure(['validate', '--file', legacyAnimationFile, '--strict'], 'E_PROJECT_INVALID').payload.diagnostics.some(item => item.code === 'E_ANIMATION_LEGACY'));
  const danglingPrefabAnimationFile = path.join(tempRoot, 'dangling-prefab-animation.ah2d.json');
  const danglingPrefabAnimationProject = createProject();
  danglingPrefabAnimationProject.animations = [clip];
  danglingPrefabAnimationProject.prefabs = [{
    id: 'animated-prefab', name: 'Animated Prefab', rootEntityId: 'source-root', revision: 1,
    entities: [{ id: 'source-root', components: { Animation: { clipId: 'missing' } } }]
  }];
  fs.writeFileSync(danglingPrefabAnimationFile, JSON.stringify(danglingPrefabAnimationProject));
  const danglingPrefabResult = failure(['validate', '--file', danglingPrefabAnimationFile], 'E_PROJECT_INVALID');
  assert.ok(danglingPrefabResult.payload.diagnostics.some(item => item.code === 'E_ANIMATION_CLIP_REFERENCE' && item.pointer === '/prefabs/0/entities/0/components/Animation/clipId'));
  danglingPrefabAnimationProject.prefabs[0].entities[0].components.Animation.clipId = 'idle';
  fs.writeFileSync(danglingPrefabAnimationFile, JSON.stringify(danglingPrefabAnimationProject));
  assert.deepStrictEqual(success(['validate', '--file', danglingPrefabAnimationFile]).diagnostics, []);
  const descriptorFile = path.join(tempRoot, 'descriptor-validation.ah2d.json');
  const descriptorFixture = createProject({ name: 'Descriptor Validation' });
  delete descriptorFixture.dataModel;
  fs.writeFileSync(descriptorFile, JSON.stringify(descriptorFixture));
  assert.deepStrictEqual(success(['validate', '--file', descriptorFile]).diagnostics, []);
  assert.deepStrictEqual(success(['validate', '--file', descriptorFile, '--strict']).diagnostics, []);

  descriptorFixture.dataModel = { id: 'ah2d.ecs', version: 0, componentSchemaVersion: 0 };
  fs.writeFileSync(descriptorFile, JSON.stringify(descriptorFixture));
  for (const args of [[], ['--strict']]) {
    const legacyDescriptor = success(['validate', '--file', descriptorFile, ...args]);
    assert.ok(legacyDescriptor.diagnostics.some(item => item.code === 'W_LEGACY_DATA_MODEL_VERSION' && item.pointer === '/dataModel/version'));
    assert.ok(legacyDescriptor.diagnostics.some(item => item.code === 'W_LEGACY_COMPONENT_SCHEMA_VERSION' && item.pointer === '/dataModel/componentSchemaVersion'));
  }

  const invalidDescriptors = [
    [[], [['E_DATA_MODEL_TYPE', '/dataModel']]],
    [{}, [
      ['E_DATA_MODEL_ID', '/dataModel/id'],
      ['E_DATA_MODEL_VERSION_TYPE', '/dataModel/version'],
      ['E_COMPONENT_SCHEMA_VERSION_TYPE', '/dataModel/componentSchemaVersion']
    ]],
    [{ id: 'other.ecs', version: 2, componentSchemaVersion: 2 }, [
      ['E_DATA_MODEL_ID', '/dataModel/id'],
      ['E_FUTURE_DATA_MODEL_VERSION', '/dataModel/version'],
      ['E_FUTURE_COMPONENT_SCHEMA_VERSION', '/dataModel/componentSchemaVersion']
    ]],
    [{ id: 'ah2d.ecs', version: '1', componentSchemaVersion: '1' }, [
      ['E_DATA_MODEL_VERSION_TYPE', '/dataModel/version'],
      ['E_COMPONENT_SCHEMA_VERSION_TYPE', '/dataModel/componentSchemaVersion']
    ]]
  ];
  for (const [value, expected] of invalidDescriptors) {
    descriptorFixture.dataModel = value;
    fs.writeFileSync(descriptorFile, JSON.stringify(descriptorFixture));
    const invalidDescriptor = failure(['validate', '--file', descriptorFile], 'E_PROJECT_INVALID').payload;
    for (const [code, pointer] of expected) assert.ok(invalidDescriptor.diagnostics.some(item => item.code === code && item.pointer === pointer), `${code} must point to ${pointer}`);
  }
  descriptorFixture.dataModel = { id: 'ah2d.ecs', version: 2, componentSchemaVersion: 1 };
  fs.writeFileSync(descriptorFile, JSON.stringify(descriptorFixture));
  const strictFutureDescriptor = failure(['validate', '--file', descriptorFile, '--strict'], 'E_PROJECT_INVALID').payload;
  assert.ok(strictFutureDescriptor.diagnostics.some(item => item.code === 'E_FUTURE_DATA_MODEL_VERSION' && item.pointer === '/dataModel/version'));

  const cycleFile = path.join(tempRoot, 'cycle-validation.ah2d.json');
  fs.writeFileSync(cycleFile, JSON.stringify(createProject({ objects: [
    { id: 'cycle-a', name: 'A', parentId: 'cycle-b' },
    { id: 'cycle-b', name: 'B', parentId: 'cycle-c' },
    { id: 'cycle-c', name: 'C', parentId: 'cycle-a' }
  ] })));
  const cycleValidation = failure(['validate', '--file', cycleFile], 'E_PROJECT_INVALID').payload;
  const cycleDiagnostic = cycleValidation.diagnostics.find(item => item.code === 'E_PARENT_CYCLE');
  assert.deepStrictEqual(cycleDiagnostic.details.cycle, ['cycle-a', 'cycle-b', 'cycle-c', 'cycle-a']);
  assert.strictEqual(cycleDiagnostic.pointer, '/scenes/0/objects/2/parentId');
  const invalidParentFile = path.join(tempRoot, 'invalid-parent.ah2d.json');
  fs.writeFileSync(invalidParentFile, JSON.stringify(createProject({ objects: [{ id: 'bad-parent', name: 'Bad Parent', parentId: 42 }] })));
  assert.ok(failure(['validate', '--file', invalidParentFile], 'E_PROJECT_INVALID').payload.diagnostics.some(item => item.code === 'E_PARENT_ID' && item.pointer === '/scenes/0/objects/0/parentId'));

  const duplicateIdProject = createProject({ objects: [
    { id: 'duplicate', name: 'First' },
    { id: 'duplicate', name: 'Second' }
  ] });
  assert.ok(validateDocument(duplicateIdProject).some(item => item.code === 'E_DUPLICATE_ENTITY_ID' && item.pointer === '/scenes/0/objects/1/id'));

  const duplicateColliderFile = path.join(tempRoot, 'duplicate-collider-id.ah2d.json');
  const duplicateColliderProject = createProject({ objects: [
    {
      id: 'fixture-owner',
      components: {
        Collider: {
          colliders: [
            { id: 'hitbox', shape: 'rectangle', width: 12, height: 8, futureFixture: { keep: 1 } },
            { id: 'hitbox', shape: 'circle', radius: 6, futureFixture: { keep: 2 } }
          ],
          futureWrapper: { keep: true }
        },
        FuturePhysicsData: { keep: ['all', 'unknown', 'fields'] }
      }
    },
    { id: 'other-entity', components: { Collider: [{ id: 'hitbox', shape: 'circle', radius: 4 }] } }
  ] });
  const duplicateColliderSource = JSON.stringify(duplicateColliderProject);
  const duplicateColliderDiagnostics = validateDocument(duplicateColliderProject);
  const duplicateCollider = duplicateColliderDiagnostics.find(item => item.code === 'E_COLLIDER_ID_DUPLICATE');
  assert.strictEqual(duplicateCollider.pointer, '/scenes/0/objects/0/components/Collider/colliders/1/id');
  assert.strictEqual(duplicateCollider.details.firstPointer, '/scenes/0/objects/0/components/Collider/colliders/0/id');
  assert.strictEqual(duplicateCollider.details.colliderId, 'hitbox');
  assert.strictEqual(duplicateColliderDiagnostics.filter(item => item.code === 'E_COLLIDER_ID_DUPLICATE').length, 1, 'Collider ids are scoped to one Entity');
  assert.strictEqual(JSON.stringify(duplicateColliderProject), duplicateColliderSource, 'CLI validation must preserve wrappers and unknown fields');
  fs.writeFileSync(duplicateColliderFile, duplicateColliderSource);
  const duplicateColliderValidation = failure(['validate', '--file', duplicateColliderFile], 'E_PROJECT_INVALID').payload;
  assert.ok(duplicateColliderValidation.diagnostics.some(item => item.code === 'E_COLLIDER_ID_DUPLICATE' && item.pointer === '/scenes/0/objects/0/components/Collider/colliders/1/id'));

  const deepObjectCount = 10000;
  const deepObjects = Array.from({ length: deepObjectCount }, (_, index) => ({
    id: 'deep-' + index,
    name: 'Deep ' + index,
    x: 1,
    ...(index ? { parentId: 'deep-' + (index - 1) } : {})
  }));
  const deepProject = createProject({ objects: deepObjects });
  let linearWorldLookups = 0;
  Object.defineProperty(deepProject.scenes[0].objects, 'find', {
    configurable: true,
    value(callback, thisArg) { linearWorldLookups += 1;return Array.prototype.find.call(this, callback, thisArg); }
  });
  const deepTree = listEntities(deepProject.scenes[0], { tree: true, world: true, path: false });
  assert.strictEqual(Object.hasOwn(deepTree.at(-1), 'path'), false);
  assert.strictEqual(deepTree.at(-1).depth, deepObjectCount - 1);
  assert.strictEqual(deepTree.at(-1).worldPosition.x, deepObjectCount);
  assert.strictEqual(linearWorldLookups, 0, 'world traversal must use one scene-local Entity index instead of Array.find per ancestor');

  const indexedObjects = Array.from({ length: deepObjectCount }, (_, index) => ({
    id: 'indexed-' + index,
    name: 'Indexed ' + index,
    ...(index ? { parentId: 'indexed-' + (index - 1) } : {})
  }));
  const indexedProject = createProject({ objects: indexedObjects });
  const originalArrayIterator = Array.prototype[Symbol.iterator];
  let fullSceneScans = 0;
  Array.prototype[Symbol.iterator] = function indexedTraversalIterator() {
    if (this.length === deepObjectCount && this[0]?.id === 'indexed-0' && this[deepObjectCount - 1]?.id === 'indexed-' + (deepObjectCount - 1)) fullSceneScans += 1;
    return originalArrayIterator.call(this);
  };
  try {
    const deepClone = applyOperations(indexedProject, [{ op: 'entity.clone', sceneId: 'main', entityId: 'indexed-0', deep: true }]);
    const clonedIds = deepClone.results[0].entityIds;
    assert.strictEqual(clonedIds.length, deepObjectCount);
    assert.strictEqual(deepClone.document.scenes[0].objects.length, deepObjectCount * 2);
    const clonedById = new Map(deepClone.document.scenes[0].objects.map(entity => [entity.id, entity]));
    assert.strictEqual(clonedById.get(clonedIds.at(-1)).parentId, clonedIds.at(-2), 'deep clone must preserve nested ordering and topology');

    const deepCascade = applyOperations(indexedProject, [{ op: 'entity.delete', sceneId: 'main', entityId: 'indexed-0', cascade: true }]);
    assert.strictEqual(deepCascade.results[0].entityIds.length, deepObjectCount);
    assert.strictEqual(deepCascade.document.scenes[0].objects.length, 0);
    assert.throws(
      () => applyOperations(indexedProject, [{ op: 'entity.reparent', sceneId: 'main', entityId: 'indexed-0', parentId: 'indexed-' + (deepObjectCount - 1) }]),
      error => error?.code === 'E_PARENT_CYCLE'
    );
  } finally {
    Array.prototype[Symbol.iterator] = originalArrayIterator;
  }
  assert.ok(fullSceneScans <= 8, `deep clone/cascade/reparent should reuse child indexes; observed ${fullSceneScans} full Scene scans`);
  assert.strictEqual(indexedProject.scenes[0].objects.length, deepObjectCount, 'deep operations must leave their source document untouched');

  const inspected = success(['inspect', '--file', projectFile]).data;
  const initialHash = inspected.sha256;
  assert.strictEqual(inspected.currentSceneId, 'main');
  const quiet = run(['inspect', '--file', projectFile, '--quiet']);
  assert.strictEqual(quiet.exitCode, 0);
  assert.strictEqual(quiet.stdout, '');
  assert.strictEqual(quiet.stderr, '');
  failure(['project', 'patch', '--file', projectFile, '--dry-run'], 'E_REQUIRED_VALUE');
  failure(['project', 'patch', '--file', projectFile, 'null', '--dry-run'], 'E_PATCH_VALUE');

  const dryScene = success(['scene', 'create', '--file', projectFile, '--id', 'arena', '--name', 'Arena', '--activate', '--dry-run', '--include-document']).data;
  assert.strictEqual(dryScene.written, false);
  assert.strictEqual(dryScene.document.scenes.length, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(projectFile, 'utf8')).scenes.length, 1, 'dry-run must not write');

  success(['scene', 'create', '--file', projectFile, '--id', 'arena', '--name', 'Arena', '--activate', '--write', '--expect-sha256', initialHash]);
  const scenes = success(['scene', 'list', '--file', projectFile]).data;
  assert.strictEqual(scenes.currentSceneId, 'arena');
  assert.strictEqual(scenes.scenes.length, 2);
  assert.strictEqual(scenes.scenes.find(scene => scene.id === 'arena').active, true);

  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'root', '--name', 'Root', '--x', '10', '--y', '20', '--write']);
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'child', '--name', 'Child', '--parent', 'root', '--write']);
  const tree = success(['entity', 'list', '--file', projectFile, '--scene', 'arena', '--tree']).data.entities;
  assert.strictEqual(tree.find(entity => entity.id === 'root').depth, 0);
  assert.strictEqual(tree.find(entity => entity.id === 'child').depth, 1);
  success(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'child', '--root', '--write']);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', 'child']).data.entity.parentId, undefined);
  success(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'child', 'root', '--write']);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', 'child']).data.entity.parentId, 'root');

  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'graph-a', '--name', 'Graph A', '--x', '100', '--y', '50', '--rotation', '90', '--scale-x', '2', '--scale-y', '2', '--write']);
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'graph-b', '--name', 'Graph B', '--x', '-20', '--y', '10', '--scale-x', '2', '--scale-y', '2', '--write']);
  const provenanceEntity = {
    id: 'transform-provenance', name: 'Transform Provenance',
    transform: { x: 900, y: 800, rotation: 0, scaleX: 1, scaleY: 1, legacyOnly: { keep: true } },
    components: { Transform: { x: 40, y: 30, rotation: 0, scaleX: 1, scaleY: 1, canonicalOnly: { keep: true } } }
  };
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--data', JSON.stringify(provenanceEntity), '--write']);
  success(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'transform-provenance', 'graph-b', '--preserve-world', '--write']);
  const provenanceStored = JSON.parse(fs.readFileSync(projectFile, 'utf8')).scenes.find(scene => scene.id === 'arena').objects.find(entity => entity.id === 'transform-provenance');
  assert.strictEqual(provenanceStored.components.Transform.canonicalOnly.keep, true);
  assert.strictEqual(provenanceStored.components.Transform.legacyOnly, undefined, 'preserve-world must not copy a lower-precedence extension');
  assert.deepStrictEqual(provenanceStored.transform, provenanceEntity.transform, 'lower-precedence Transform storage must remain untouched');
  assert.strictEqual(provenanceStored.components.Transform.x, 30);
  assert.strictEqual(provenanceStored.components.Transform.y, 10);
  assert.strictEqual(provenanceStored.x, 0, 'flat lower-precedence Transform must remain untouched');
  const provenanceCloneId = success(['entity', 'clone', '--file', projectFile, '--scene', 'arena', 'transform-provenance', '--name', 'Transform Provenance Copy', '--write']).data.results[0].entityId;
  const provenanceClone = JSON.parse(fs.readFileSync(projectFile, 'utf8')).scenes.find(scene => scene.id === 'arena').objects.find(entity => entity.id === provenanceCloneId);
  assert.strictEqual(provenanceClone.components.Transform.canonicalOnly.keep, true);
  assert.strictEqual(provenanceClone.components.Transform.legacyOnly, undefined, 'clone offset must not promote a lower-precedence extension');
  assert.deepStrictEqual(provenanceClone.transform, provenanceEntity.transform, 'clone offset must leave lower-precedence Transform storage untouched');
  assert.strictEqual(provenanceClone.components.Transform.x, 54);
  assert.strictEqual(provenanceClone.components.Transform.y, 34);


  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'joint', '--name', 'Joint', '--parent', 'graph-a', '--x', '10', '--y', '0', '--write']);
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'leaf', '--name', 'Leaf', '--parent', 'joint', '--x', '0', '--y', '5', '--write']);
  let worldTree = success(['entity', 'tree', '--file', projectFile, '--scene', 'arena', '--world']).data.entities;
  let jointTree = worldTree.find(entity => entity.id === 'joint'), leafTree = worldTree.find(entity => entity.id === 'leaf');
  assert.deepStrictEqual(leafTree.path, ['graph-a', 'joint', 'leaf']);
  assert.strictEqual(leafTree.depth, 2);
  assert.strictEqual(jointTree.childCount, 1);
  assertMatrixClose(jointTree.worldMatrix, [0, 2, -2, 0, 100, 70], 'nested joint world');
  assertMatrixClose(leafTree.worldMatrix, [0, 2, -2, 0, 90, 70], 'three-level leaf world');
  const worldText = runText(['entity', 'tree', '--file', projectFile, '--scene', 'arena', '--world', '--format', 'text']);
  assert.strictEqual(worldText.exitCode, 0, worldText.stderr);
  assert.match(worldText.stdout, /joint\tJoint\tworld=\[/);


  const preserveWorld = success(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'joint', 'graph-b', '--preserve-world', '--write']).data.results[0];
  assert.strictEqual(preserveWorld.transformMode, 'preserve-world');
  assertMatrixClose(preserveWorld.worldMatrix, [0, 2, -2, 0, 100, 70], 'reparent must preserve joint world');
  assertMatrixClose([preserveWorld.localTransform.x, preserveWorld.localTransform.y], [60, 30], 'reparent must derive local position');
  worldTree = success(['entity', 'list', '--file', projectFile, '--scene', 'arena', '--tree', '--world']).data.entities;
  leafTree = worldTree.find(entity => entity.id === 'leaf');
  assert.deepStrictEqual(leafTree.path, ['graph-b', 'joint', 'leaf']);
  assertMatrixClose(leafTree.worldMatrix, [0, 2, -2, 0, 90, 70], 'subtree world must remain stable');

  const localBefore = success(['component', 'get', '--file', projectFile, '--scene', 'arena', 'joint', 'Transform']).data.value;
  const preserveLocal = success(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'joint', 'graph-a', '--preserve-local', '--write']).data.results[0];
  assert.strictEqual(preserveLocal.transformMode, 'preserve-local');
  assertMatrixClose([preserveLocal.localTransform.x, preserveLocal.localTransform.y, preserveLocal.localTransform.rotation, preserveLocal.localTransform.scaleX, preserveLocal.localTransform.scaleY], [localBefore.x, localBefore.y, localBefore.rotation, localBefore.scaleX, localBefore.scaleY], 'preserve-local must not rewrite Transform');
  failure(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'graph-a', 'leaf', '--write'], 'E_PARENT_CYCLE');
  failure(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'joint', 'graph-b', '--preserve-local', '--preserve-world', '--write'], 'E_REPARENT_TRANSFORM_MODE');

  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'singular-parent', '--name', 'Singular', '--scale-x', '0', '--write']);
  const beforeSingular = fs.readFileSync(projectFile, 'utf8');
  failure(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'joint', 'singular-parent', '--preserve-world', '--write'], 'E_NON_INVERTIBLE_TRANSFORM');
  assert.strictEqual(fs.readFileSync(projectFile, 'utf8'), beforeSingular, 'failed preserve-world must be atomic');
  const beforeDetachWorld = success(['entity', 'list', '--file', projectFile, '--scene', 'arena', '--tree', '--world']).data.entities.find(entity => entity.id === 'joint').worldMatrix;
  const detachedWorld = success(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'joint', '--root', '--preserve-world', '--write']).data.results[0];
  assertMatrixClose(detachedWorld.worldMatrix, beforeDetachWorld, 'detach must preserve world when requested');

  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'delete-grand', '--name', 'Delete Grand', '--x', '100', '--y', '50', '--rotation', '90', '--scale-x', '2', '--scale-y', '2', '--write']);
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'delete-middle', '--name', 'Delete Middle', '--parent', 'delete-grand', '--x', '10', '--write']);
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'delete-leaf', '--name', 'Delete Leaf', '--parent', 'delete-middle', '--y', '5', '--write']);
  const beforeDeleteWorld = success(['entity', 'tree', '--file', projectFile, '--scene', 'arena', '--world']).data.entities.find(entity => entity.id === 'delete-leaf').worldMatrix;
  const deleteReparent = success(['entity', 'delete', '--file', projectFile, '--scene', 'arena', 'delete-middle', '--reparent', '--preserve-world', '--write']).data.results[0];
  assert.strictEqual(deleteReparent.transformMode, 'preserve-world');
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', 'delete-leaf']).data.entity.parentId, 'delete-grand');
  const afterDeleteWorld = success(['entity', 'tree', '--file', projectFile, '--scene', 'arena', '--world']).data.entities.find(entity => entity.id === 'delete-leaf').worldMatrix;
  assertMatrixClose(afterDeleteWorld, beforeDeleteWorld, 'delete --reparent --preserve-world must preserve each direct child world matrix');
  failure(['entity', 'delete', '--file', projectFile, '--scene', 'arena', 'delete-leaf', '--preserve-world', '--dry-run'], 'E_DELETE_TRANSFORM_MODE');
  failure(['entity', 'delete', '--file', projectFile, '--scene', 'arena', 'delete-leaf', '--reparent', '--preserve-local', '--preserve-world', '--dry-run'], 'E_REPARENT_TRANSFORM_MODE');
  failure(['entity', 'delete', '--file', projectFile, '--scene', 'arena', 'delete-leaf', '--cascade', '--reparent', '--dry-run'], 'E_DELETE_MODE');
  failure(['entity', 'delete', '--file', projectFile, '--scene', 'arena', 'delete-leaf', '--cascade', '--reparent', '--preserve-world', '--dry-run'], 'E_DELETE_MODE');


  const beforeCycle = fs.readFileSync(projectFile, 'utf8');
  failure(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'root', 'child', '--write'], 'E_PARENT_CYCLE');
  assert.strictEqual(fs.readFileSync(projectFile, 'utf8'), beforeCycle, 'failed mutation must roll back completely');
  failure(['entity', 'delete', '--file', projectFile, '--scene', 'arena', 'root', '--write'], 'E_ENTITY_HAS_CHILDREN');
  failure(['entity', 'patch', '--file', projectFile, '--scene', 'arena', 'child', '--dry-run'], 'E_REQUIRED_VALUE');
  failure(['entity', 'patch', '--file', projectFile, '--scene', 'arena', 'child', 'null', '--dry-run'], 'E_PATCH_VALUE');

  success(['component', 'put', '--file', projectFile, '--scene', 'arena', 'child', 'Rigidbody', '--write']);
  success(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'child', 'Rigidbody', '{"mass":2,"gravityScale":0.5}', '--write']);
  success(['component', 'put', '--file', projectFile, '--scene', 'arena', 'child', 'Collider', '--write']);
  const beforeDuplicateColliderPut = fs.readFileSync(projectFile, 'utf8');
  failure([
    'component', 'put', '--file', projectFile, '--scene', 'arena', 'child', 'Collider',
    '--value', JSON.stringify([{ id: 'same-fixture', shape: 'box' }, { id: 'same-fixture', shape: 'circle' }]),
    '--write'
  ], 'E_COLLIDER_ID_DUPLICATE');
  assert.strictEqual(fs.readFileSync(projectFile, 'utf8'), beforeDuplicateColliderPut, 'duplicate Collider ids must fail atomically');
  const rigidbody = success(['component', 'get', '--file', projectFile, '--scene', 'arena', 'child', 'Rigidbody']).data.value;
  assert.strictEqual(rigidbody.mass, 2);
  assert.strictEqual(rigidbody.gravityScale, 0.5);
  assert.strictEqual(success(['component', 'get', '--file', projectFile, '--scene', 'arena', '--entity-id', 'child', 'Rigidbody']).data.value.mass, 2);
  assert.strictEqual(success(['component', 'get', '--file', projectFile, '--scene', 'arena', '--entity-name', 'Child', 'Collider']).data.value.shape, 'rectangle');
  failure(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'child', 'Rigidbody', '--dry-run'], 'E_REQUIRED_VALUE');
  failure(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'child', 'Rigidbody', 'null', '--dry-run'], 'E_PATCH_VALUE');
  success(['entity', 'set', '--file', projectFile, '--scene', 'arena', '--entity-id', 'child', 'x', '77', '--write']);
  success(['entity', 'set', '--file', projectFile, '--scene', 'arena', '--entity-name', 'Child', 'y', '88', '--write']);
  success(['entity', 'set', '--file', projectFile, '--scene', 'arena', 'child', 'sx', '0', '--write']);
  success(['entity', 'set', '--file', projectFile, '--scene', 'arena', 'child', 'sy', '0', '--write']);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', 'child']).data.entity.x, 77);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', 'child']).data.entity.y, 88);
  const zeroScale = success(['component', 'get', '--file', projectFile, '--scene', 'arena', 'child', 'Transform']).data.value;
  assert.strictEqual(zeroScale.scaleX, 0);
  assert.strictEqual(zeroScale.scaleY, 0);
  failure(['component', 'put', '--file', projectFile, '--scene', 'arena', 'child', 'constructor', '--write'], 'E_COMPONENT_NAME');

  const precedenceEntity = {
    id: 'precedence', name: 'Precedence', x: 0, y: 0, rot: 0, sx: 1, sy: 1,
    rigidbody: { type: 'dynamic', mass: 9, legacyOnly: { keep: true } },
    components: {
      Rigidbody: { type: 'dynamic', mass: 2, futureField: { keep: true } },
      FutureGameplay: { score: 10, nested: { keep: true } }
    },
    unknownEntityField: { keep: true }
  };
  const conflictMutation = success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--data', JSON.stringify(precedenceEntity), '--write']);
  const conflictDiagnostic = conflictMutation.diagnostics.find(item => item.code === 'E_COMPONENT_CONFLICT' && item.details?.type === 'Rigidbody');
  assert.ok(conflictDiagnostic, 'flat/components conflict should be diagnosed');
  assert.ok(conflictDiagnostic.pointer.endsWith('/components/Rigidbody'));
  const effectiveBody = success(['component', 'get', '--file', projectFile, '--scene', 'arena', 'precedence', 'Body']).data;
  assert.strictEqual(effectiveBody.component, 'Rigidbody');
  assert.strictEqual(effectiveBody.storage, 'components.Rigidbody');
  assert.strictEqual(effectiveBody.value.mass, 2);

  const beforeInvalidComponent = fs.readFileSync(projectFile, 'utf8');
  const invalidComponent = failure(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'precedence', 'Rigidbody', '{"mass":0}', '--dry-run'], 'E_COMPONENT_EXCLUSIVE_MINIMUM');
  assert.ok(invalidComponent.payload.error.pointer.endsWith('/components/Rigidbody/mass'));
  assert.ok(invalidComponent.payload.diagnostics.some(item => item.pointer.endsWith('/components/Rigidbody/mass')));
  assert.strictEqual(fs.readFileSync(projectFile, 'utf8'), beforeInvalidComponent);

  success(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'precedence', 'Rigidbody', '{"mass":3}', '--write']);
  success(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'precedence', 'FutureGameplay', '{"score":11}', '--write']);
  project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  let precedenceStored = project.scenes.find(scene => scene.id === 'arena').objects.find(entity => entity.id === 'precedence');
  assert.strictEqual(precedenceStored.components.Rigidbody.mass, 3);
  assert.strictEqual(precedenceStored.components.Rigidbody.futureField.keep, true);
  assert.strictEqual(precedenceStored.rigidbody.mass, 9);
  assert.strictEqual(precedenceStored.rigidbody.legacyOnly.keep, true);
  assert.deepStrictEqual(precedenceStored.components.FutureGameplay, { score: 11, nested: { keep: true } });
  assert.strictEqual(precedenceStored.unknownEntityField.keep, true);
  success(['component', 'delete', '--file', projectFile, '--scene', 'arena', 'precedence', 'Rigidbody', '--write']);
  assert.strictEqual(success(['component', 'get', '--file', projectFile, '--scene', 'arena', 'precedence', 'Rigidbody']).data.storage, 'rigidbody');
  precedenceStored = JSON.parse(fs.readFileSync(projectFile, 'utf8')).scenes.find(scene => scene.id === 'arena').objects.find(entity => entity.id === 'precedence');
  assert.strictEqual(precedenceStored.components.Rigidbody, undefined);
  assert.strictEqual(precedenceStored.rigidbody.mass, 9);

  const legacyPrefab = {
    id: 'prefab-promotion', name: 'Prefab Promotion', x: 0, y: 0, rot: 0, sx: 1, sy: 1,
    prefab: true, assetId: 'prefab-asset'
  };
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--data', JSON.stringify(legacyPrefab), '--write']);
  const prefabPromotion = success(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'prefab-promotion', 'PrefabInstance', '{"prefabId":"prefab-source","overrides":{"tint":"blue"},"futurePrefab":{"keep":true}}', '--write']).data.results[0];
  assert.strictEqual(prefabPromotion.storage, 'components.PrefabInstance');
  assert.strictEqual(prefabPromotion.provenance, 'components.PrefabInstance');
  const promotedPrefab = JSON.parse(fs.readFileSync(projectFile, 'utf8')).scenes.find(scene => scene.id === 'arena').objects.find(entity => entity.id === 'prefab-promotion');
  assert.deepStrictEqual(promotedPrefab.components.PrefabInstance, {
    assetId: 'prefab-asset', prefabId: 'prefab-source', overrides: { tint: 'blue' }, futurePrefab: { keep: true }
  });

  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--data', JSON.stringify({ id: 'prefab-root', name: 'Crate Rig', x: 12, y: 34, color: '#886633', futureEntity: { keep: true } }), '--write']);
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--data', JSON.stringify({ id: 'prefab-child', name: 'Crate Lid', parentId: 'prefab-root', x: 4, y: -8, color: '#aa8844', removable: { keep: true }, futureBranch: { a: 1, b: 2 }, shiftValues: ['a', 'b', 'c'], components: { FuturePrefab: { x: 0, sibling: 'source' } } }), '--write']);
  const prefabHash = success(['inspect', '--file', projectFile]).data.sha256;
  const prefabDryRun = success(['prefab', 'asset', 'create', '--file', projectFile, '--scene', 'arena', '--entity', 'prefab-root', '--id', 'crate-prefab', '--name', 'Crate', '--dry-run', '--include-document', '--expect-sha256', prefabHash]).data;
  assert.strictEqual(prefabDryRun.document.prefabs[0].rootEntityId, 'prefab-root');
  assert.strictEqual(JSON.parse(fs.readFileSync(projectFile, 'utf8')).prefabs.length, 0, 'Prefab dry-run must not write');
  failure(['prefab', 'asset', 'create', '--file', projectFile, '--scene', 'arena', '--entity', 'prefab-root', '--id', 'crate-prefab', '--write', '--expect-sha256', '0'.repeat(64)], 'E_HASH_MISMATCH');
  success(['prefab', 'asset', 'create', '--file', projectFile, '--scene', 'arena', '--entity', 'prefab-root', '--id', 'crate-prefab', '--name', 'Crate', '--write', '--expect-sha256', prefabHash]);
  const prefabList = success(['prefab', 'asset', 'list', '--file', projectFile]).data.prefabs;
  assert.deepStrictEqual(prefabList.find(item => item.id === 'crate-prefab'), { id: 'crate-prefab', name: 'Crate', rootEntityId: 'prefab-root', entityCount: 2 });
  let crateAsset = success(['prefab', 'asset', 'get', '--file', projectFile, 'crate-prefab']).data.prefab;
  assert.strictEqual(crateAsset.revision, 1);
  assert.strictEqual(crateAsset.entities.find(entity => entity.id === 'prefab-root').futureEntity.keep, true);
  assert.deepStrictEqual(
    { x: crateAsset.entities.find(entity => entity.id === 'prefab-root').x, y: crateAsset.entities.find(entity => entity.id === 'prefab-root').y, rot: crateAsset.entities.find(entity => entity.id === 'prefab-root').rot, sx: crateAsset.entities.find(entity => entity.id === 'prefab-root').sx, sy: crateAsset.entities.find(entity => entity.id === 'prefab-root').sy },
    { x: 0, y: 0, rot: 0, sx: 1, sy: 1 },
    'captured Prefab Asset root must use identity local Transform'
  );
  project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  let arenaObjects = project.scenes.find(scene => scene.id === 'arena').objects;
  assert.deepStrictEqual(arenaObjects.find(entity => entity.id === 'prefab-root').components.PrefabInstance, {
    prefabId: 'crate-prefab', sourceEntityId: 'prefab-root', instanceRootId: 'prefab-root', prefabRevision: 1, overrides: {}
  });
  assert.deepStrictEqual(
    { x: arenaObjects.find(entity => entity.id === 'prefab-root').x, y: arenaObjects.find(entity => entity.id === 'prefab-root').y },
    { x: 12, y: 34 },
    'linking the captured source must preserve its Scene placement'
  );

  const firstInstance = success(['prefab', 'instantiate', '--file', projectFile, '--scene', 'arena', 'crate-prefab', '--id', 'crate-instance-a', '--x', '500', '--y', '600', '--write']).data.results[0];
  const secondInstance = success(['prefab', 'instance', 'create', '--file', projectFile, '--scene', 'arena', 'crate-prefab', '--id', 'crate-instance-b', '--x', '700', '--y', '800', '--write']).data.results[0];
  const firstChild = firstInstance.idMap['prefab-child'], secondChild = secondInstance.idMap['prefab-child'];
  success(['prefab', 'instantiate', '--file', projectFile, '--scene', 'main', 'crate-prefab', '--id', 'crate-instance-a', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', '--path', '/color', '--value', '"#335577"', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', '--path', '/color', '--write']);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'main', 'crate-instance-a']).data.entity.color, '#335577', 'Apply must synchronize a same-ID instance in another Scene');
  failure(['component', 'patch', '--file', projectFile, '--scene', 'arena', firstChild, 'PrefabInstance', '{"futureMarker":{"keep":true}}', '--dry-run'], 'E_PREFAB_INSTANCE_EDIT');
  project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const prefabSceneIndex = project.scenes.findIndex(scene => scene.id === 'arena');
  const firstChildIndex = project.scenes[prefabSceneIndex].objects.findIndex(entity => entity.id === firstChild);
  success(['patch', '--file', projectFile, '--patch', JSON.stringify([{
    op: 'add', path: `/scenes/${prefabSceneIndex}/objects/${firstChildIndex}/components/PrefabInstance/futureMarker`, value: { keep: true }
  }]), '--write']);
  failure(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'illegal-prefab-child', '--parent', firstChild, '--dry-run'], 'E_PREFAB_STRUCTURAL_EDIT');
  failure(['prefab', 'instantiate', '--file', projectFile, '--scene', 'arena', 'crate-prefab', '--parent', firstChild, '--dry-run'], 'E_PREFAB_STRUCTURAL_EDIT');
  failure(['entity', 'clone', '--file', projectFile, '--scene', 'arena', firstChild, '--dry-run'], 'E_PREFAB_STRUCTURAL_EDIT');
  failure(['entity', 'rename', '--file', projectFile, '--scene', 'arena', firstChild, 'Illegal Rename', '--dry-run'], 'E_PREFAB_INSTANCE_EDIT');
  failure(['entity', 'set', '--file', projectFile, '--scene', 'arena', firstChild, 'color', '"#ffffff"', '--dry-run'], 'E_PREFAB_INSTANCE_EDIT');
  failure(['component', 'patch', '--file', projectFile, '--scene', 'arena', firstChild, 'Name', '{"value":"Illegal Rename"}', '--dry-run'], 'E_PREFAB_INSTANCE_EDIT');
  failure(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', firstChild, '--root', '--dry-run'], 'E_PREFAB_STRUCTURAL_EDIT');
  failure(['entity', 'delete', '--file', projectFile, '--scene', 'arena', firstChild, '--cascade', '--dry-run'], 'E_PREFAB_STRUCTURAL_EDIT');
  const sceneClone = success(['scene', 'clone', '--file', projectFile, '--scene', 'arena', '--id', 'arena-prefab-clone', '--dry-run', '--include-document']).data.document.scenes.find(scene => scene.id === 'arena-prefab-clone');
  const clonedFirstRoot = sceneClone.objects.find(entity => entity.components?.PrefabInstance?.prefabId === 'crate-prefab' && entity.components.PrefabInstance.sourceEntityId === 'prefab-root' && entity.x === 500);
  assert.ok(clonedFirstRoot, 'Scene clone must retain connected Prefab instances');
  assert.strictEqual(clonedFirstRoot.components.PrefabInstance.instanceRootId, clonedFirstRoot.id, 'Scene clone must remap Prefab instanceRootId');
  const firstOverride = success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/color', '--value', '"#ff0000"', '--write']).data.results[0];
  assert.deepStrictEqual(firstOverride.override, { op: 'replace', value: '#ff0000' });
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', secondChild, '--path', 'color', '--value', '"#0000ff"', '--write']);
  const inspectedOverride = success(['prefab', 'overrides', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides[0];
  assert.deepStrictEqual(inspectedOverride.source, { exists: true, value: '#aa8844' });
  assert.deepStrictEqual(inspectedOverride.current, { exists: true, value: '#ff0000' });
  assert.deepStrictEqual(inspectedOverride.override, { op: 'replace', value: '#ff0000' });
  const appliedOverride = success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/color', '--write']).data.results[0];
  assert.strictEqual(appliedOverride.appliedCount, 1);
  crateAsset = success(['prefab', 'asset', 'get', '--file', projectFile, 'crate-prefab']).data.prefab;
  assert.strictEqual(crateAsset.entities.find(entity => entity.id === 'prefab-child').color, '#ff0000');
  assert.strictEqual(crateAsset.revision, 3);
  const independentOverride = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', secondChild]).data.overrides[0];
  assert.deepStrictEqual(independentOverride.source, { exists: true, value: '#ff0000' });
  assert.deepStrictEqual(independentOverride.current, { exists: true, value: '#0000ff' });
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', secondChild, '--path', '/color', '--write']);
  assert.deepStrictEqual(success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', secondChild]).data.overrides, []);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', secondChild]).data.entity.color, '#ff0000');

  crateAsset = success(['prefab', 'asset', 'get', '--file', projectFile, 'crate-prefab']).data.prefab;
  assert.strictEqual(crateAsset.entities.find(entity => entity.id === 'prefab-root').components, undefined, 'fixture must exercise a compact Asset source without a components map');
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', '--path', '/components/Health', '--value', '{"current":5}', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', '--path', '/components/Health', '--write']);
  crateAsset = success(['prefab', 'asset', 'get', '--file', projectFile, 'crate-prefab']).data.prefab;
  assert.deepStrictEqual(crateAsset.entities.find(entity => entity.id === 'prefab-root').components.Health, { current: 5 }, 'applying a whole-component add must synthesize the missing Asset components map');
  assert.deepStrictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', 'crate-instance-b']).data.entity.components.Health, { current: 5 });

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable/keep', '--remove', '--write']);
  const removalOverride = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides[0];
  assert.deepStrictEqual(removalOverride.override, { op: 'remove' });
  assert.deepStrictEqual(removalOverride.current, { exists: false });
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--write']);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.removable.keep, true);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/color', '--value', '"#00ff00"', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable/keep', '--value', 'false', '--write']);
  assert.strictEqual(success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', '--all']).data.overrides.length, 2);
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--all', '--write']);
  assert.deepStrictEqual(success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides, [], 'multi-path revert must not reintroduce a previously cleared record');
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/addedByInstance', '--value', '{"keep":true}', '--write']);
  assert.deepStrictEqual(success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides[0].override, { op: 'add', value: { keep: true } });
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', firstChild, '--write']);
  assert.deepStrictEqual(success(['prefab', 'asset', 'get', '--file', projectFile, 'crate-prefab']).data.prefab.entities.find(entity => entity.id === 'prefab-child').addedByInstance, { keep: true });

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/temporaryLocal', '--value', '{"keep":true}', '--write']);
  const clearedLocalAdd = success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/temporaryLocal', '--remove', '--write']).data.results[0];
  assert.strictEqual(clearedLocalAdd.override, null, 'removing a source-absent local add must not store an invalid remove operation');
  assert.strictEqual(clearedLocalAdd.reverted, true);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.temporaryLocal, undefined);
  assert.strictEqual(success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.some(item => item.path === '/temporaryLocal'), false);

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/components/FuturePrefab', '--value', '{"x":1,"sibling":"keep"}', '--write']);
  const nestedSet = success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/components/FuturePrefab/x', '--value', '2', '--write']).data.results[0];
  assert.strictEqual(nestedSet.storedPath, '/components/FuturePrefab');
  let owningOverride = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.find(item => item.path === '/components/FuturePrefab');
  assert.deepStrictEqual(owningOverride.override, { op: 'replace', value: { x: 2, sibling: 'keep' } }, 'nested set must rebase the owning ancestor without losing siblings');
  const nestedRemove = success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/components/FuturePrefab/x', '--remove', '--write']).data.results[0];
  assert.strictEqual(nestedRemove.storedPath, '/components/FuturePrefab');
  owningOverride = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.find(item => item.path === '/components/FuturePrefab');
  assert.deepStrictEqual(owningOverride.override, { op: 'replace', value: { sibling: 'keep' } }, 'nested remove must preserve sibling values in the owning override');
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/components/FuturePrefab', '--write']);

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable', '--value', '{"keep":false}', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable/keep', '--value', 'false', '--write']);
  let overlapOverrides = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.filter(item => item.path.startsWith('/removable'));
  assert.deepStrictEqual(overlapOverrides.map(item => item.path), ['/removable'], 'nested edits must remain represented by one owning ancestor record');
  assert.deepStrictEqual(overlapOverrides[0].override, { op: 'replace', value: { keep: false } });
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable', '--write']);

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable/keep', '--value', 'false', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', secondChild, '--path', '/removable', '--value', '{"keep":true,"synced":42}', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', secondChild, '--path', '/removable', '--write']);
  let firstNested = success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.removable;
  assert.deepStrictEqual(firstNested, { keep: false, synced: 42 }, 'Asset parent changes must sync siblings while preserving descendant overrides');
  let nestedOverride = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.find(item => item.path === '/removable/keep');
  assert.deepStrictEqual(nestedOverride.source, { exists: true, value: true });
  assert.deepStrictEqual(nestedOverride.current, { exists: true, value: false });
  assert.deepStrictEqual(nestedOverride.override, { op: 'replace', value: false });
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable/keep', '--write']);

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable', '--value', '{"keep":false,"local":true}', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', secondChild, '--path', '/removable/keep', '--value', 'false', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', secondChild, '--path', '/removable/keep', '--write']);
  firstNested = success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.removable;
  assert.deepStrictEqual(firstNested, { keep: false, local: true }, 'an ancestor override must own its complete branch during Asset synchronization');
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/removable', '--write']);

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/futureBranch/a', '--value', '9', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/futureBranch', '--remove', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/futureBranch', '--write']);
  let promotedBranch = success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.futureBranch;
  assert.deepStrictEqual(promotedBranch, { a: 9, b: 2 }, 'removing an Asset ancestor must preserve the effective branch owned by a descendant override');
  let promotedOverride = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.find(item => item.path === '/futureBranch');
  assert.deepStrictEqual(promotedOverride.override, { op: 'add', value: { a: 9, b: 2 } }, 'an orphaned descendant must promote to a reconstructable ancestor add');
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/futureBranch', '--write']);

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/futureBranch', '--value', '{"a":1,"b":2}', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/futureBranch', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/futureBranch/a', '--value', '9', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/futureBranch', '--value', '"retyped"', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/futureBranch', '--write']);
  promotedBranch = success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.futureBranch;
  assert.deepStrictEqual(promotedBranch, { a: 9, b: 2 }, 'retyping an Asset ancestor must preserve an incompatible descendant override branch');
  promotedOverride = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.find(item => item.path === '/futureBranch');
  assert.deepStrictEqual(promotedOverride.override, { op: 'replace', value: { a: 9, b: 2 } }, 'a descendant orphaned by retyping must promote to an ancestor replace');
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/futureBranch', '--write']);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.futureBranch, 'retyped');

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/shiftValues/2', '--value', '"X"', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/shiftValues/0', '--remove', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/shiftValues/0', '--write']);
  assert.deepStrictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.shiftValues, ['b', 'X'], 'array removal must preserve a later overridden element');
  let shiftedOverrides = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.filter(item => item.path.startsWith('/shiftValues'));
  assert.strictEqual(shiftedOverrides.some(item => item.path === '/shiftValues/2'), false, 'array removal must clear the obsolete index pointer');
  assert.deepStrictEqual(shiftedOverrides.find(item => item.path === '/shiftValues/1').override, { op: 'replace', value: 'X' }, 'array removal must reindex a later override pointer');
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/shiftValues/1', '--write']);

  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/shiftValues/0', '--value', '"Local B"', '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/shiftValues/0', '--remove', '--write']);
  success(['prefab', 'override', 'apply', '--file', projectFile, '--scene', 'arena', 'prefab-child', '--path', '/shiftValues/0', '--write']);
  assert.deepStrictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.shiftValues, ['Local B', 'c'], 'an override on a removed array element must retain a reconstructable array');
  shiftedOverrides = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.filter(item => item.path.startsWith('/shiftValues'));
  assert.deepStrictEqual(shiftedOverrides.map(item => item.path), ['/shiftValues']);
  assert.deepStrictEqual(shiftedOverrides[0].override, { op: 'replace', value: ['Local B', 'c'] }, 'a removed overridden index must promote to ownership of the complete array');
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/shiftValues', '--write']);
  assert.deepStrictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', firstChild]).data.entity.shiftValues, ['c']);

  failure(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', '--path', '/x', '--value', '1', '--dry-run'], 'E_PREFAB_PLACEMENT_PATH');
  failure(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', '--path', '/rot', '--value', '45', '--dry-run'], 'E_PREFAB_PLACEMENT_PATH');

  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'prefab-placement-parent', '--name', 'Prefab Placement Parent', '--write']);
  success(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', 'prefab-placement-parent', '--write']);
  success(['entity', 'set', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', 'rot', '25', '--write']);
  success(['entity', 'set', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', 'sx', '1.5', '--write']);
  success(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', 'Transform', '{"placementExtension":{"keep":true}}', '--write']);
  project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const caseVariantRootIndex = project.scenes[prefabSceneIndex].objects.findIndex(entity => entity.id === 'crate-instance-a');
  const canonicalRootPlacement = project.scenes[prefabSceneIndex].objects[caseVariantRootIndex].components.Transform;
  success(['patch', '--file', projectFile, '--patch', JSON.stringify([
    { op: 'add', path: `/scenes/${prefabSceneIndex}/objects/${caseVariantRootIndex}/components/TRANSFORM`, value: canonicalRootPlacement },
    { op: 'remove', path: `/scenes/${prefabSceneIndex}/objects/${caseVariantRootIndex}/components/Transform` }
  ]), '--write']);
  success(['prefab', 'override', 'set', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/components/FuturePrefab/x', '--value', '9', '--write']);
  crateAsset = success(['prefab', 'asset', 'get', '--file', projectFile, 'crate-prefab']).data.prefab;
  const rebuiltSources = JSON.parse(JSON.stringify(crateAsset.entities));
  rebuiltSources.find(entity => entity.id === 'prefab-root').x = 123;
  rebuiltSources.find(entity => entity.id === 'prefab-root').y = 456;
  rebuiltSources.find(entity => entity.id === 'prefab-child').components.FuturePrefab.x = 5;
  success(['prefab', 'asset', 'update', '--file', projectFile, 'crate-prefab', '--patch', JSON.stringify({ futureAsset: { keep: true }, entities: rebuiltSources }), '--write']);
  failure(['prefab', 'asset', 'update', '--file', projectFile, 'crate-prefab', '--scene', 'arena', '--entity', 'crate-instance-a', '--dry-run'], 'E_PREFAB_UPDATE_SOURCE_INSTANCE');
  project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  arenaObjects = project.scenes.find(scene => scene.id === 'arena').objects;
  const placedRoot = arenaObjects.find(entity => entity.id === 'crate-instance-a');
  const placedTransform = placedRoot.components.TRANSFORM;
  assert.strictEqual(placedRoot.components.Transform, undefined, 'Asset sync must preserve the explicit case-variant Transform provenance');
  assert.strictEqual(placedRoot.parentId, 'prefab-placement-parent', 'Asset sync must preserve root placement parent');
  assert.strictEqual(placedTransform.x, 500, 'Asset sync must preserve root placement X');
  assert.strictEqual(placedTransform.y, 600, 'Asset sync must preserve root placement Y');
  assert.strictEqual(placedTransform.rotation, 25, 'Asset sync must preserve root placement rotation');
  assert.strictEqual(placedTransform.scaleX, 1.5, 'Asset sync must preserve root placement scale');
  assert.strictEqual(placedTransform.placementExtension.keep, true, 'Asset sync must preserve the complete root Transform placement representation');
  assert.strictEqual(arenaObjects.find(entity => entity.id === firstChild).components.PrefabInstance.futureMarker.keep, true, 'Prefab sync must preserve marker extensions');
  assert.strictEqual(arenaObjects.find(entity => entity.id === firstChild).components.FuturePrefab.x, 9, 'Asset rebuild must preserve and rebase an independent override');
  assert.strictEqual(arenaObjects.find(entity => entity.id === secondChild).components.FuturePrefab.x, 5, 'Asset rebuild must synchronize members without that override');
  const rebuiltOverride = success(['prefab', 'override', 'inspect', '--file', projectFile, '--scene', 'arena', firstChild]).data.overrides.find(item => item.path === '/components/FuturePrefab/x');
  assert.deepStrictEqual(rebuiltOverride.source, { exists: true, value: 5 });
  assert.deepStrictEqual(rebuiltOverride.current, { exists: true, value: 9 });
  assert.deepStrictEqual(rebuiltOverride.override, { op: 'replace', value: 9 });
  success(['prefab', 'override', 'revert', '--file', projectFile, '--scene', 'arena', firstChild, '--path', '/components/FuturePrefab/x', '--write']);
  assert.strictEqual(project.prefabs.find(prefab => prefab.id === 'crate-prefab').futureAsset.keep, true);
  assert.deepStrictEqual(
    { x: project.prefabs.find(prefab => prefab.id === 'crate-prefab').entities.find(entity => entity.id === 'prefab-root').x, y: project.prefabs.find(prefab => prefab.id === 'crate-prefab').entities.find(entity => entity.id === 'prefab-root').y },
    { x: 0, y: 0 },
    'Prefab Asset update must retain root identity Transform'
  );
  failure(['prefab', 'asset', 'delete', '--file', projectFile, 'crate-prefab', '--write'], 'E_PREFAB_IN_USE');
  success(['prefab', 'unpack', '--file', projectFile, '--scene', 'arena', 'crate-instance-a', '--write']);
  assert.strictEqual(success(['component', 'list', '--file', projectFile, '--scene', 'arena', 'crate-instance-a']).data.components.some(component => component.type === 'PrefabInstance'), false);
  success(['entity', 'rename', '--file', projectFile, '--scene', 'arena', firstChild, 'Unpacked Crate Lid', '--write']);
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--id', 'unpacked-prefab-child', '--parent', firstChild, '--write']);
  success(['prefab', 'asset', 'delete', '--file', projectFile, 'crate-prefab', '--unpack-instances', '--write']);
  assert.strictEqual(success(['prefab', 'asset', 'list', '--file', projectFile]).data.prefabs.some(prefab => prefab.id === 'crate-prefab'), false);
  project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.strictEqual(project.scenes.find(scene => scene.id === 'arena').objects.filter(entity => entity.components?.PrefabInstance?.prefabId === 'crate-prefab').length, 0);
  assert.strictEqual(project.scenes.find(scene => scene.id === 'main').objects.filter(entity => entity.components?.PrefabInstance?.prefabId === 'crate-prefab').length, 0);

  const stalePrefabFile = path.join(tempRoot, 'stale-prefab.ah2d.json');
  const stalePrefabProject = createProject({ name: 'Stale Prefab Lifecycle' });
  stalePrefabProject.prefabs = [{
    id: 'stale-prefab', name: 'Stale Prefab', rootEntityId: 'stale-source-root', revision: 2,
    entities: [
      { id: 'stale-source-root', name: 'Asset Root' },
      { id: 'stale-source-child', name: 'Asset Child', parentId: 'stale-source-root', foo: 'new' }
    ]
  }];
  stalePrefabProject.scenes[0].objects = [
    { id: 'stale-root', name: 'Asset Root', components: { PrefabInstance: {
      prefabId: 'stale-prefab', sourceEntityId: 'stale-source-root', instanceRootId: 'stale-root', prefabRevision: 1, overrides: {}
    } } },
    { id: 'stale-child', name: 'Local Child', parentId: 'stale-root', foo: 'old', components: { PrefabInstance: {
      prefabId: 'stale-prefab', sourceEntityId: 'stale-source-child', instanceRootId: 'stale-root', prefabRevision: 1,
      overrides: { '/name': { op: 'replace', value: 'Local Child' } }
    } } },
    { id: 'current-root', name: 'Asset Root', components: { PrefabInstance: {
      prefabId: 'stale-prefab', sourceEntityId: 'stale-source-root', instanceRootId: 'current-root', prefabRevision: 2, overrides: {}
    } } },
    { id: 'current-child', name: 'Asset Child', parentId: 'current-root', foo: 'new', components: { PrefabInstance: {
      prefabId: 'stale-prefab', sourceEntityId: 'stale-source-child', instanceRootId: 'current-root', prefabRevision: 2, overrides: {}
    } } }
  ];
  stalePrefabProject.scene = JSON.parse(JSON.stringify(stalePrefabProject.scenes[0].objects));
  fs.writeFileSync(stalePrefabFile, JSON.stringify(stalePrefabProject));
  const mixedPrefabFile = path.join(tempRoot, 'mixed-prefab-revision.ah2d.json');
  const mixedPrefabProject = JSON.parse(JSON.stringify(stalePrefabProject));
  mixedPrefabProject.scenes[0].objects.find(entity => entity.id === 'stale-child').components.PrefabInstance.prefabRevision = 2;
  mixedPrefabProject.scene = JSON.parse(JSON.stringify(mixedPrefabProject.scenes[0].objects));
  fs.writeFileSync(mixedPrefabFile, JSON.stringify(mixedPrefabProject));
  const mixedRevisionValidation = failure(['validate', '--file', mixedPrefabFile], 'E_PROJECT_INVALID').payload;
  assert.ok(mixedRevisionValidation.diagnostics.some(item => item.code === 'E_PREFAB_INSTANCE_REVISION_MISMATCH'), 'CLI validation must reject mixed revisions within one expanded Instance');
  success(['prefab', 'override', 'apply', '--file', stalePrefabFile, '--scene', 'main', 'stale-child', '--path', '/name', '--write']);
  let staleResult = JSON.parse(fs.readFileSync(stalePrefabFile, 'utf8'));
  let staleObjects = staleResult.scenes[0].objects;
  assert.strictEqual(staleResult.prefabs[0].revision, 3);
  assert.deepStrictEqual(
    staleObjects.filter(entity => entity.id.startsWith('stale-')).map(entity => entity.components.PrefabInstance.prefabRevision),
    [1, 1],
    'every member of the initiating stale group must remain at its old revision'
  );
  assert.deepStrictEqual(
    staleObjects.filter(entity => entity.id.startsWith('current-')).map(entity => entity.components.PrefabInstance.prefabRevision),
    [3, 3],
    'every member of a previously-current group may advance together'
  );
  assert.strictEqual(staleObjects.find(entity => entity.id === 'current-child').name, 'Local Child');

  success(['prefab', 'override', 'set', '--file', stalePrefabFile, '--scene', 'main', 'current-child', '--path', '/foo', '--value', '"applied"', '--write']);
  success(['prefab', 'override', 'apply', '--file', stalePrefabFile, '--scene', 'main', 'current-child', '--path', '/foo', '--write']);
  staleResult = JSON.parse(fs.readFileSync(stalePrefabFile, 'utf8'));
  staleObjects = staleResult.scenes[0].objects;
  assert.strictEqual(staleObjects.find(entity => entity.id === 'stale-child').foo, 'old', 'Asset path sync must not partially mutate a stale group');
  assert.deepStrictEqual(staleObjects.filter(entity => entity.id.startsWith('stale-')).map(entity => entity.components.PrefabInstance.prefabRevision), [1, 1]);
  assert.deepStrictEqual(staleObjects.filter(entity => entity.id.startsWith('current-')).map(entity => entity.components.PrefabInstance.prefabRevision), [4, 4]);

  const staleUpdate = success(['prefab', 'asset', 'update', '--file', stalePrefabFile, 'stale-prefab', '--patch', '{"name":"Updated Prefab"}', '--write']).data.results[0];
  assert.deepStrictEqual(
    { synchronized: staleUpdate.synchronized.instanceCount, stale: staleUpdate.synchronized.staleInstanceCount },
    { synchronized: 1, stale: 1 },
    'Asset update must rebuild only groups that were current at the previous revision'
  );
  staleResult = JSON.parse(fs.readFileSync(stalePrefabFile, 'utf8'));
  staleObjects = staleResult.scenes[0].objects;
  assert.deepStrictEqual(staleObjects.filter(entity => entity.id.startsWith('stale-')).map(entity => entity.components.PrefabInstance.prefabRevision), [1, 1]);
  assert.deepStrictEqual(staleObjects.filter(entity => entity.id.startsWith('current-')).map(entity => entity.components.PrefabInstance.prefabRevision), [5, 5]);
  const staleValidation = success(['validate', '--file', stalePrefabFile]);
  assert.ok(staleValidation.diagnostics.some(item => item.code === 'W_PREFAB_INSTANCE_STALE'));
  assert.strictEqual(staleValidation.diagnostics.some(item => item.code === 'E_PREFAB_INSTANCE_REVISION_MISMATCH' || item.code === 'E_PREFAB_INSTANCE_STATE'), false);

  success(['scene', 'rename', '--file', projectFile, '--scene', 'arena', 'Arena Renamed', '--write']);
  assert.strictEqual(success(['entity', 'list', '--file', projectFile, '--scene-name', 'Arena Renamed']).data.sceneId, 'arena');
  success(['resource', 'put', '--file', projectFile, 'folders', 'AgentContent', '--write']);
  assert.ok(success(['resource', 'list', '--file', projectFile, 'folders']).data.items.includes('AgentContent'));
  failure(['resource', 'put', '--file', projectFile, 'folders', 'null', '--dry-run'], 'E_RESOURCE_VALUE');

  success(['runtime', 'set', '--file', projectFile, '--runtime', 'pixijs', '--write']);
  failure(['physics', 'set', '--file', projectFile, '--dry-run'], 'E_REQUIRED_VALUE');
  success(['physics', 'set', '--file', projectFile, '--gravity-x', '0', '--gravity-y', '100', '--pixels-per-meter', '50', '--write']);
  const nativePhysics = success(['physics', 'get', '--file', projectFile]).data;
  assert.deepStrictEqual(
    { requested: nativePhysics.requested, backend: nativePhysics.backend, implementation: nativePhysics.implementation, native: nativePhysics.native },
    { requested: 'box2d', backend: 'box2d', implementation: 'planck', native: true }
  );
  const builtinSetting = success(['physics', 'set', '--file', projectFile, '--backend', 'builtin', '--write']).data.results[0];
  assert.deepStrictEqual(
    { requested: builtinSetting.requested, backend: builtinSetting.backend, implementation: builtinSetting.implementation, native: builtinSetting.native },
    { requested: 'builtin', backend: 'builtin', implementation: 'ah2d-builtin', native: false }
  );
  const builtinPhysics = success(['physics', 'get', '--file', projectFile]).data;
  assert.strictEqual(builtinPhysics.physics, 'builtin');
  assert.strictEqual(builtinPhysics.requested, 'builtin');
  const persistedBuiltinSimulation = success(['simulate', '--file', projectFile, '--scene', 'arena', '--steps', '1', '--dt', '0.0166666667']).data;
  assert.deepStrictEqual(
    { requested: persistedBuiltinSimulation.physics.requested, backend: persistedBuiltinSimulation.physics.backend, implementation: persistedBuiltinSimulation.physics.implementation, native: persistedBuiltinSimulation.physics.native },
    { requested: 'builtin', backend: 'builtin', implementation: 'ah2d-builtin', native: false }
  );
  success(['physics', 'set', '--file', projectFile, '--backend', 'box2d', '--write']);
  failure(['physics', 'set', '--file', projectFile, '--backend', 'unknown', '--dry-run'], 'E_PHYSICS_BACKEND');
  const validation = success(['validate', '--file', projectFile, '--engine']).data;
  assert.strictEqual(validation.valid, true);
  assert.deepStrictEqual(
    { requested: validation.physics.requested, backend: validation.physics.backend, implementation: validation.physics.implementation, native: validation.physics.native },
    { requested: 'box2d', backend: 'box2d', implementation: 'planck', native: true }
  );
  const builtinValidation = success(['validate', '--file', projectFile, '--engine', '--backend', 'builtin']).data;
  assert.deepStrictEqual(
    { requested: builtinValidation.physics.requested, backend: builtinValidation.physics.backend, implementation: builtinValidation.physics.implementation, native: builtinValidation.physics.native },
    { requested: 'builtin', backend: 'builtin', implementation: 'ah2d-builtin', native: false }
  );

  const hashBeforeMismatch = documentHash(fs.readFileSync(projectFile, 'utf8'));
  failure(['scene', 'rename', '--file', projectFile, '--scene', 'arena', '--name', 'Changed', '--write', '--expect-sha256', '0'.repeat(64)], 'E_HASH_MISMATCH');
  assert.strictEqual(documentHash(fs.readFileSync(projectFile, 'utf8')), hashBeforeMismatch);

  const batch = [
    { op: 'entity.create', sceneId: 'arena', id: 'camera', name: 'Camera' },
    { op: 'component.put', sceneId: 'arena', entityId: 'camera', component: 'Camera', value: { primary: true } },
    { op: 'entity.create', sceneName: 'Arena Renamed', id: 'spawn', name: 'Spawn' },
    { op: 'resource.put', resource: 'folders', value: 'Levels' }
  ];
  success(['apply', '--file', projectFile, '--ops', JSON.stringify(batch), '--write']);
  project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.ok(project.scenes.find(scene => scene.id === 'arena').objects.some(entity => entity.id === 'camera'));
  assert.ok(project.scenes.find(scene => scene.id === 'arena').objects.some(entity => entity.id === 'spawn'));
  assert.ok(project.folders.includes('Levels'));

  const beforeFailedBatch = fs.readFileSync(projectFile, 'utf8');
  const failedBatch = [
    { op: 'entity.create', sceneId: 'arena', id: 'temporary', name: 'Temporary' },
    { op: 'entity.create', sceneId: 'arena', id: 'camera', name: 'Duplicate' }
  ];
  failure(['apply', '--file', projectFile, '--ops', JSON.stringify(failedBatch), '--write'], 'E_ENTITY_EXISTS');
  assert.strictEqual(fs.readFileSync(projectFile, 'utf8'), beforeFailedBatch, 'batch must be atomic');
  for (const preserveWorld of [false, true]) {
    const beforeDeleteModeBatch = fs.readFileSync(projectFile, 'utf8');
    const deleteOperation = { op: 'entity.delete', sceneId: 'arena', entityId: 'root', cascade: true, reparent: true };
    if (preserveWorld) deleteOperation.preserveWorld = true;
    const contradictoryDeleteBatch = [
      { op: 'entity.create', sceneId: 'arena', id: 'delete-mode-temporary', name: 'Temporary' },
      deleteOperation
    ];
    failure(['apply', '--file', projectFile, '--ops', JSON.stringify(contradictoryDeleteBatch), '--write'], 'E_DELETE_MODE');
    assert.strictEqual(fs.readFileSync(projectFile, 'utf8'), beforeDeleteModeBatch, 'contradictory delete mode must roll back its complete apply batch');
  }

  const longTransformEntity = {
    id: 'long-transform', name: 'Long Transform', x: 0, y: 0,
    rotation: 10, scaleX: 1, scaleY: 1,
    rigidbody: { type: 'dynamic', mass: 1, gravityScale: 0, angularVelocity: 60 }
  };
  success(['entity', 'create', '--file', projectFile, '--scene', 'arena', '--data', JSON.stringify(longTransformEntity), '--write']);
  success(['entity', 'patch', '--file', projectFile, '--scene', 'arena', 'long-transform', '{"rot":null,"sx":null,"sy":null}', '--write']);
  const longTransformBefore = JSON.parse(fs.readFileSync(projectFile, 'utf8')).scenes.find(scene => scene.id === 'arena').objects.find(entity => entity.id === 'long-transform');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(longTransformBefore, 'rot'), false);
  success(['simulate', '--file', projectFile, '--scene', 'arena', '--steps', '1', '--dt', '0.0166666667', '--commit', '--write']);
  const longTransformAfter = JSON.parse(fs.readFileSync(projectFile, 'utf8')).scenes.find(scene => scene.id === 'arena').objects.find(entity => entity.id === 'long-transform');
  assert.ok(longTransformAfter.rotation > longTransformBefore.rotation, 'simulate commit must update the effective long-form rotation');
  for (const key of ['rot', 'sx', 'sy']) assert.strictEqual(Object.prototype.hasOwnProperty.call(longTransformAfter, key), false, `simulate commit must not add stale ${key}`);


  const firstSimulation = success(['simulate', '--file', projectFile, '--scene', 'arena', '--steps', '10', '--dt', '0.0166666667']).data;
  const secondSimulation = success(['simulate', '--file', projectFile, '--scene', 'arena', '--steps', '10', '--dt', '0.0166666667']).data;
  assert.deepStrictEqual(firstSimulation.entities, secondSimulation.entities, 'fixed-step simulation must be deterministic');
  assert.deepStrictEqual(
    { requested: firstSimulation.physics.requested, backend: firstSimulation.physics.backend, implementation: firstSimulation.physics.implementation, native: firstSimulation.physics.native },
    { requested: 'box2d', backend: 'box2d', implementation: 'planck', native: true }
  );
  const builtinSimulation = success(['simulate', '--file', projectFile, '--scene', 'arena', '--backend', 'builtin', '--steps', '1', '--dt', '0.0166666667']).data;
  assert.deepStrictEqual(
    { requested: builtinSimulation.physics.requested, backend: builtinSimulation.physics.backend, implementation: builtinSimulation.physics.implementation, native: builtinSimulation.physics.native },
    { requested: 'builtin', backend: 'builtin', implementation: 'ah2d-builtin', native: false }
  );
  assert.strictEqual(firstSimulation.committed, false);
  failure(['simulate', '--file', projectFile, '--scene', 'arena', '--backend', 'unknown'], 'E_PHYSICS_BACKEND');
  failure(['simulate', '--file', projectFile, '--scene', 'arena', '--steps', '1', '--commit'], 'E_WRITE_MODE');
  success(['simulate', '--file', projectFile, '--scene', 'arena', '--steps', '1', '--commit', '--write']);

  const nativeEcsExport = success(['ecs', 'export', '--file', projectFile, '--scene', 'arena']).data;
  const ecs = nativeEcsExport.document;
  assert.deepStrictEqual(
    { requested: nativeEcsExport.physics.requested, backend: nativeEcsExport.physics.backend, implementation: nativeEcsExport.physics.implementation, native: nativeEcsExport.physics.native },
    { requested: 'box2d', backend: 'box2d', implementation: 'planck', native: true }
  );
  assert.strictEqual(ecs.format, 'AH2D');
  assert.strictEqual(ecs.sceneId, 'arena');
  assert.ok(ecs.entities.some(entity => entity.id === 'child'));
  const builtinEcsExport = success(['ecs', 'export', '--file', projectFile, '--scene', 'arena', '--backend', 'builtin']).data;
  assert.strictEqual(builtinEcsExport.physics.backend, 'builtin');
  assert.strictEqual(builtinEcsExport.physics.implementation, 'ah2d-builtin');

  const query = success(['query', '--file', projectFile, '--pointer', '/engine/runtime']).data;
  assert.strictEqual(query.value, 'pixijs');
  const patched = success(['patch', '--file', projectFile, '--patch', '[{"op":"replace","path":"/meta/name","value":"Patched"}]', '--dry-run', '--include-document']).data.document;
  assert.strictEqual(patched.meta.name, 'Patched');
  assert.notStrictEqual(JSON.parse(fs.readFileSync(projectFile, 'utf8')).meta.name, 'Patched');
  failure(['patch', '--file', projectFile, '--patch', '[{"op":"add","path":"/meta/name/child","value":1}]', '--dry-run'], 'E_POINTER_PARENT');

  const sceneAsset = path.join(tempRoot, 'arena.scene.json');
  success(['scene', 'export', '--file', projectFile, '--scene', 'arena', '--out', sceneAsset]);
  assert.strictEqual(JSON.parse(fs.readFileSync(sceneAsset, 'utf8')).format, 'AH2D.Scene');
  success(['scene', 'import', '--file', projectFile, '--input', sceneAsset, '--id', 'arena-imported', '--name', 'Imported Arena', '--write']);
  assert.strictEqual(success(['scene', 'get', '--file', projectFile, '--scene', 'arena-imported']).data.scene.name, 'Imported Arena');

  success(['format', '--file', projectFile, '--check']);

  const legacyFile = path.join(tempRoot, 'legacy.json'), migratedFile = path.join(tempRoot, 'migrated.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ format: 'AH2D', version: 3, engine: '0.2.0', unknownPluginData: { keep: true }, entities: [{ id: 'ecs-player', components: { Name: { value: 'ECS Player' }, Transform: { x: 1, y: 2 }, Rigidbody: { type: 'dynamic', mass: 1, futureTuning: { keep: true } }, FutureGameplay: { nested: { keep: true } } } }] }));
  success(['migrate', '--file', legacyFile, '--out', migratedFile]);
  let migrated = JSON.parse(fs.readFileSync(migratedFile, 'utf8'));
  assert.strictEqual(migrated.version, 4);
  assert.strictEqual(migrated.unknownPluginData.keep, true, 'unknown fields must survive migration');
  assert.strictEqual(migrated.scenes[0].objects[0].components.Rigidbody.mass, 1);
  success(['component', 'patch', '--file', migratedFile, '--scene', 'main', 'ecs-player', 'Rigidbody', '{"mass":3}', '--write']);
  migrated = JSON.parse(fs.readFileSync(migratedFile, 'utf8'));
  const ecsEntity = migrated.scenes[0].objects[0];
  assert.strictEqual(ecsEntity.components.Rigidbody.mass, 3);
  assert.strictEqual(ecsEntity.components.Rigidbody.futureTuning.keep, true);
  assert.deepStrictEqual(ecsEntity.components.FutureGameplay, { nested: { keep: true } });
  assert.strictEqual(ecsEntity.rigidbody, undefined, 'ECS component storage must remain lossless');

  const flatV4File = path.join(tempRoot, 'flat-v4.json'), flatV4Output = path.join(tempRoot, 'flat-v4-migrated.json');
  const flatV4 = createProject({ objects: [{ id: 'flat-v4', name: 'Flat V4', x: 0, y: 0, rot: 0, sx: 1, sy: 1, rigidbody: { type: 'dynamic', mass: 1, futureField: { keep: true } }, unknownEntityField: { keep: true } }] });
  delete flatV4.dataModel;
  fs.writeFileSync(flatV4File, JSON.stringify(flatV4));
  success(['migrate', '--file', flatV4File, '--out', flatV4Output]);
  const flatV4Migrated = JSON.parse(fs.readFileSync(flatV4Output, 'utf8'));
  const flatV4Entity = flatV4Migrated.scenes[0].objects[0];
  assert.strictEqual(flatV4Migrated.version, 4);
  assert.strictEqual(flatV4Migrated.dataModel, undefined, 'migration must not inject descriptor into an existing v4 project');
  assert.strictEqual(flatV4Entity.rigidbody.mass, 1);
  assert.strictEqual(flatV4Entity.rigidbody.futureField.keep, true);
  assert.strictEqual(flatV4Entity.components, undefined, 'v4 migration must not rewrite legacy storage');
  assert.strictEqual(flatV4Entity.unknownEntityField.keep, true);

  console.log('AH2D CLI tests passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
