'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('./ah2d.js');
const { createProject, documentHash } = require('./AH2DProject.js');

function run(args) {
  let stdout = '', stderr = '';
  const io = { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } };
  const exitCode = main(args, io);
  let payload = null;
  const source = stdout.trim() || stderr.trim();
  if (source) payload = JSON.parse(source);
  return { exitCode, stdout, stderr, payload };
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

  const schemaIndex = success(['schema', 'list']).data;
  assert.deepStrictEqual(schemaIndex.schemas, ['project', 'operation', 'batch']);
  assert.ok(schemaIndex.components.includes('Collider'));
  const transformSchema = success(['schema', 'show', '--component', 'Transform']).data;
  assert.strictEqual(transformSchema.name, 'component:Transform');
  assert.strictEqual(transformSchema.component.type, 'Transform');
  assert.strictEqual(transformSchema.component.schemas.authoring.properties.scaleX.type, 'number');
  const aliasedSchema = success(['schema', 'show', 'component:Body']).data;
  assert.strictEqual(aliasedSchema.name, 'component:Rigidbody');
  assert.strictEqual(aliasedSchema.component.type, 'Rigidbody');
  assert.strictEqual(success(['schema', 'show', '--name', 'project']).data.schema.title, 'AH2D Project');


  const initialized = success(['init', '--file', projectFile, '--name', 'Agent Test']).data;
  assert.strictEqual(initialized.created, true);
  assert.ok(fs.existsSync(projectFile));
  let project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.strictEqual(project.format, 'AH2D');
  assert.strictEqual(project.version, 4);
  assert.deepStrictEqual(project.dataModel, { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 });
  assert.strictEqual(project.scenes.length, 1);
  assert.ok(project.postProcess.effects.some(effect => effect.type === 'bloom'));
  assert.ok(project.postProcess.effects.some(effect => effect.type === 'crt'));
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

  const beforeCycle = fs.readFileSync(projectFile, 'utf8');
  failure(['entity', 'reparent', '--file', projectFile, '--scene', 'arena', 'root', 'child', '--write'], 'E_PARENT_CYCLE');
  assert.strictEqual(fs.readFileSync(projectFile, 'utf8'), beforeCycle, 'failed mutation must roll back completely');
  failure(['entity', 'delete', '--file', projectFile, '--scene', 'arena', 'root', '--write'], 'E_ENTITY_HAS_CHILDREN');
  failure(['entity', 'patch', '--file', projectFile, '--scene', 'arena', 'child', '--dry-run'], 'E_REQUIRED_VALUE');
  failure(['entity', 'patch', '--file', projectFile, '--scene', 'arena', 'child', 'null', '--dry-run'], 'E_PATCH_VALUE');

  success(['component', 'put', '--file', projectFile, '--scene', 'arena', 'child', 'Rigidbody', '--write']);
  success(['component', 'patch', '--file', projectFile, '--scene', 'arena', 'child', 'Rigidbody', '{"mass":2,"gravityScale":0.5}', '--write']);
  success(['component', 'put', '--file', projectFile, '--scene', 'arena', 'child', 'Collider', '--write']);
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

  success(['scene', 'rename', '--file', projectFile, '--scene', 'arena', 'Arena Renamed', '--write']);
  assert.strictEqual(success(['entity', 'list', '--file', projectFile, '--scene-name', 'Arena Renamed']).data.sceneId, 'arena');
  success(['resource', 'put', '--file', projectFile, 'folders', 'AgentContent', '--write']);
  assert.ok(success(['resource', 'list', '--file', projectFile, 'folders']).data.items.includes('AgentContent'));
  failure(['resource', 'put', '--file', projectFile, 'folders', 'null', '--dry-run'], 'E_RESOURCE_VALUE');

  success(['runtime', 'set', '--file', projectFile, '--runtime', 'pixijs', '--write']);
  failure(['physics', 'set', '--file', projectFile, '--dry-run'], 'E_REQUIRED_VALUE');
  success(['physics', 'set', '--file', projectFile, '--gravity-x', '0', '--gravity-y', '100', '--pixels-per-meter', '50', '--write']);
  const validation = success(['validate', '--file', projectFile, '--engine']).data;
  assert.strictEqual(validation.valid, true);

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
  assert.strictEqual(firstSimulation.committed, false);
  failure(['simulate', '--file', projectFile, '--scene', 'arena', '--steps', '1', '--commit'], 'E_WRITE_MODE');
  success(['simulate', '--file', projectFile, '--scene', 'arena', '--steps', '1', '--commit', '--write']);

  const ecs = success(['ecs', 'export', '--file', projectFile, '--scene', 'arena']).data.document;
  assert.strictEqual(ecs.format, 'AH2D');
  assert.strictEqual(ecs.sceneId, 'arena');
  assert.ok(ecs.entities.some(entity => entity.id === 'child'));

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
