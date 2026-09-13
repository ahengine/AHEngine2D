'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('./ah2d.js');
const { documentHash } = require('./AH2DProject.js');

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

  const initialized = success(['init', '--file', projectFile, '--name', 'Agent Test']).data;
  assert.strictEqual(initialized.created, true);
  assert.ok(fs.existsSync(projectFile));
  let project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.strictEqual(project.format, 'AH2D');
  assert.strictEqual(project.version, 4);
  assert.strictEqual(project.scenes.length, 1);
  assert.ok(project.postProcess.effects.some(effect => effect.type === 'bloom'));
  assert.ok(project.postProcess.effects.some(effect => effect.type === 'crt'));

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
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', 'child']).data.entity.x, 77);
  assert.strictEqual(success(['entity', 'get', '--file', projectFile, '--scene', 'arena', 'child']).data.entity.y, 88);
  failure(['component', 'put', '--file', projectFile, '--scene', 'arena', 'child', 'constructor', '--write'], 'E_COMPONENT_NAME');

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
  fs.writeFileSync(legacyFile, JSON.stringify({ format: 'AH2D', version: 3, engine: '0.2.0', unknownPluginData: { keep: true }, entities: [{ id: 'ecs-player', components: { Name: { value: 'ECS Player' }, Transform: { x: 1, y: 2 }, Rigidbody: { type: 'dynamic', mass: 1 } } }] }));
  success(['migrate', '--file', legacyFile, '--out', migratedFile]);
  let migrated = JSON.parse(fs.readFileSync(migratedFile, 'utf8'));
  assert.strictEqual(migrated.version, 4);
  assert.strictEqual(migrated.unknownPluginData.keep, true, 'unknown fields must survive migration');
  assert.strictEqual(migrated.scenes[0].objects[0].components.Rigidbody.mass, 1);
  success(['component', 'patch', '--file', migratedFile, '--scene', 'main', 'ecs-player', 'Rigidbody', '{"mass":3}', '--write']);
  migrated = JSON.parse(fs.readFileSync(migratedFile, 'utf8'));
  const ecsEntity = migrated.scenes[0].objects[0];
  assert.strictEqual(ecsEntity.components.Rigidbody.mass, 3);
  assert.strictEqual(ecsEntity.rigidbody, undefined, 'ECS component storage must remain lossless');

  console.log('AH2D CLI tests passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
