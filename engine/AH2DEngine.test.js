global.window = global;
global.requestAnimationFrame = () => 101;
global.cancelAnimationFrame = () => {};
require('./AH2DEngine.js');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const near = (actual, expected, epsilon = 1e-5, message = '') => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message} expected ${expected}, received ${actual}`);
};

const testSceneGraphAndRuntimes = () => {
  const engine = new AH2D.Engine({ runtime: 'custom' });
  engine.load({ scene: [
    { id: 'parent', name: 'Parent', x: 10, y: 20 },
    { id: 'child', name: 'Child', x: 5, y: 6, parentId: 'parent' }
  ] });
  assert.deepStrictEqual(engine.graph.getChildren('parent'), ['child']);
  assert.strictEqual(engine.ecs.get('child', 'Transform').world[4], 15);
  assert.strictEqual(engine.ecs.get('child', 'Transform').world[5], 26);
  assert.throws(() => engine.graph.attach('parent', 'child'), /cycle/, 'cycle guard must reject invalid parenting');
  engine.useRuntime('pixijs'); assert.strictEqual(engine.runtime.name, 'pixijs');
  assert.strictEqual(engine.runtime.backend, 'editor-bridge', 'PixiJS must report compatibility mode when PIXI is not loaded');
  engine.useRuntime('phaserjs'); assert.strictEqual(engine.runtime.name, 'phaserjs');
  assert.strictEqual(engine.runtime.backend, 'editor-bridge', 'PhaserJS must report compatibility mode when Phaser is not loaded');
  engine.useRuntime(new AH2D.CustomRuntimeAdapter()); assert.strictEqual(engine.runtime.name, 'custom');
  assert.strictEqual(engine.export().format, 'AH2D');
  assert.strictEqual(engine.physics.name, 'box2d');
  assert.strictEqual(engine.physics.backend, 'builtin', 'Box2D adapter must have a dependency-free fallback');
};

const testUnifiedComponentSchemas = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  const conflicts = [];
  engine.events.on('component:conflict', event => conflicts.push(event));
  engine.createEntity({
    id: 'mixed-storage',
    x: 1,
    rigidbody: { type: 'dynamic', mass: 9 },
    components: {
      Transform: { x: 12, y: 8 },
      Rigidbody: { type: 'dynamic', mass: 2 },
      FutureGameplay: { score: 7, extension: { keep: true } }
    }
  });
  assert.strictEqual(engine.ecs.get('mixed-storage', 'Transform').x, 12);
  assert.strictEqual(engine.ecs.get('mixed-storage', 'Transform').y, 8);
  assert.strictEqual(engine.ecs.get('mixed-storage', 'Body').mass, 2);
  assert.deepStrictEqual(engine.ecs.get('mixed-storage', 'FutureGameplay'), { score: 7, extension: { keep: true } });
  assert.ok(conflicts.length > 0, 'mixed component storage must emit conflict diagnostics');

  const snapshot = engine.export();
  assert.strictEqual(snapshot.version, 3, 'runtime snapshot compatibility remains version 3');
  assert.deepStrictEqual(snapshot.dataModel, { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 });
  assert.strictEqual(snapshot.entities[0].components.FutureGameplay.extension.keep, true);

  const descriptor = engine.registerComponent({
    type: 'Health',
    defaults: { current: 100 },
    schema: {
      type: 'object',
      required: ['current'],
      properties: { current: { type: 'number', minimum: 0 } },
      additionalProperties: true
    }
  });
  assert.strictEqual(descriptor.type, 'Health');
  engine.createEntity({ id: 'custom-component', components: { Health: { current: 75 } } });
  assert.strictEqual(engine.ecs.get('custom-component', 'Health').current, 75);
  assert.throws(
    () => engine.ecs.add('custom-component', 'Health', { current: -1 }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_COMPONENT_MINIMUM'
  );

  const lowLevelId = engine.ecs.create('low-level-alias');
  engine.ecs.add(lowLevelId, 'RigidBody', { type: 'static', mass: 1 });
  assert.strictEqual(engine.ecs.get(lowLevelId, 'Rigidbody').type, 'static');
  const transform = engine.ecs.add(lowLevelId, 'Transform', { x: 0, y: 0, rot: 45, sx: 0, sy: 2 });
  assert.strictEqual(transform.rotation, 45);
  assert.strictEqual(transform.scaleX, 0);
  assert.strictEqual(transform.scaleY, 2);
};

const testEntityValidationBeforeRuntimeClone = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  assert.throws(
    () => engine.createEntity({ id: '', name: 'Invalid' }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_ENTITY_ID'
  );
  assert.throws(
    () => engine.createEntity({ id: 'non-json', components: { FutureData: { keep: true, callback() {} } } }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_COMPONENT_JSON_TYPE'
  );
  assert.throws(
    () => engine.createEntity(42),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_ENTITY_VALUE'
  );
  assert.throws(
    () => engine.createEntity(null),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_ENTITY_VALUE'
  );
  assert.throws(
    () => engine.createEntity({ id: 'runtime-invalid', rigidbody: { fixedRotation: 'false' } }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_COMPONENT_TYPE' && error.pointer === '/rigidbody/fixedRotation'
  );
  assert.strictEqual(engine.ecs.entities.has('runtime-invalid'), false, 'runtime validation failures must not leave a partial Entity');
  assert.throws(() => engine.createEntity({ id: 'self-parent', parentId: 'self-parent' }), /cycle/);
  assert.strictEqual(engine.ecs.entities.has('self-parent'), false, 'graph validation failures must not leave a partial Entity');
  assert.strictEqual(engine.ecs.entities.size, 0);

  const generated = engine.createEntity({ name: 'Generated' });
  assert.strictEqual(typeof generated, 'string');
  assert.ok(generated.length > 0);

  engine.createEntity({ id: 'duplicate', components: { Health: { current: 1 } } });
  assert.throws(
    () => engine.createEntity({ id: 'duplicate', components: { Mana: { current: 2 } } }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_ENTITY_EXISTS'
  );
  assert.deepStrictEqual(engine.ecs.get('duplicate', 'Health'), { current: 1 });
  assert.strictEqual(engine.ecs.get('duplicate', 'Mana'), undefined);
};

const testDistinctColliderComponents = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.createEntity({
    id: 'multi-collider',
    components: {
      BoxCollider2D: { id: 'box-2d', width: 10, height: 10 },
      BoxCollider: [{ id: 'box-a', width: 12, height: 12 }, { id: 'box-b', width: 14, height: 14 }],
      CircleCollider2D: { id: 'circle-2d', radius: 4 },
      CircleCollider: { colliders: [{ id: 'circle-a', radius: 5 }, { id: 'circle-b', radius: 6 }] }
    }
  });
  engine.update(0);
  const colliders = engine.physics.getBody('multi-collider').colliders;
  assert.deepStrictEqual(colliders.map(collider => collider.id).sort(), ['box-2d', 'box-a', 'box-b', 'circle-2d', 'circle-a', 'circle-b']);
  for (const collider of colliders.filter(item => item.id.startsWith('box'))) assert.strictEqual(collider.shape, 'box');
  for (const collider of colliders.filter(item => item.id.startsWith('circle'))) assert.strictEqual(collider.shape, 'circle');
};
const testMultiSceneLoading = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  const project = {
    format: 'AH2D', version: 4, currentSceneId: 'level-b',
    scenes: [
      { id: 'level-a', name: 'Level A', objects: [{ id: 'a-object', name: 'A' }] },
      { id: 'level-b', name: 'Level B', objects: [{ id: 'b-object', name: 'B' }] }
    ],
    scene: [{ id: 'legacy-object', name: 'Legacy Active Scene' }]
  };
  engine.load(project);
  assert.strictEqual(engine.activeSceneId, 'level-b', 'project currentSceneId must choose the active Scene');
  assert.ok(engine.ecs.entities.has('b-object'));
  assert.ok(!engine.ecs.entities.has('legacy-object'), 'multi-Scene projects must not fall back to the legacy active scene');
  assert.deepStrictEqual(engine.document.scene, engine.document.scenes[1].objects, 'top-level scene must mirror the active Scene objects');
  engine.loadScene('level-a');
  assert.strictEqual(engine.activeSceneId, 'level-a');
  assert.ok(engine.ecs.entities.has('a-object'));
  assert.ok(!engine.ecs.entities.has('b-object'));
  assert.strictEqual(engine.document.currentSceneId, 'level-a');
  assert.deepStrictEqual(engine.document.scene, engine.document.scenes[0].objects, 'loadScene must synchronize the compatibility mirror');
  assert.throws(() => engine.loadScene('missing-scene'), /Unknown Scene/);
};

const testAtomicLoadValidation = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({
    scene: [{ id: 'stable', name: 'Stable', components: { Health: { current: 10 } } }],
    postProcess: { enabled: true, effects: [{ id: 'stable-grade', type: 'custom', enabled: true, extension: { keep: true } }] }
  });
  const beforeDocument = JSON.stringify(engine.document);
  const beforeSnapshot = JSON.stringify(engine.export());

  assert.throws(
    () => engine.load({ scene: [{ id: 'staged-good' }, { id: 'staged-bad', components: { Rigidbody: { mass: -1 } } }] }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_COMPONENT_EXCLUSIVE_MINIMUM'
  );
  assert.strictEqual(JSON.stringify(engine.document), beforeDocument);
  assert.strictEqual(JSON.stringify(engine.export()), beforeSnapshot);
  assert.ok(engine.ecs.entities.has('stable'));
  assert.ok(!engine.ecs.entities.has('staged-good'));

  assert.throws(
    () => engine.load({ scene: [{ id: 'cycle-a', parentId: 'cycle-b' }, { id: 'cycle-b', parentId: 'cycle-a' }] }),
    /cycle/
  );
  assert.strictEqual(JSON.stringify(engine.document), beforeDocument);
  assert.strictEqual(JSON.stringify(engine.export()), beforeSnapshot);
  assert.ok(engine.ecs.entities.has('stable'));

  assert.throws(
    () => engine.load({ scene: [{ id: 'orphan', parentId: 'missing' }] }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_DANGLING_PARENT'
  );
  assert.strictEqual(JSON.stringify(engine.document), beforeDocument);
  assert.strictEqual(JSON.stringify(engine.export()), beforeSnapshot);

  assert.throws(
    () => engine.load(42),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_DOCUMENT_TYPE'
  );
  assert.throws(
    () => engine.load({ scene: [null] }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_ENTITY_VALUE'
  );
  for (const [dataModel, code, pointer] of [
    [null, 'E_DATA_MODEL_TYPE', '/dataModel'],
    [{ id: 'other.ecs', version: 1, componentSchemaVersion: 1 }, 'E_DATA_MODEL_ID', '/dataModel/id'],
    [{ id: 'ah2d.ecs', componentSchemaVersion: 1 }, 'E_DATA_MODEL_VERSION_TYPE', '/dataModel/version'],
    [{ id: 'ah2d.ecs', version: 1 }, 'E_COMPONENT_SCHEMA_VERSION_TYPE', '/dataModel/componentSchemaVersion'],
    [{ id: 'ah2d.ecs', version: 2, componentSchemaVersion: 1 }, 'E_FUTURE_DATA_MODEL_VERSION', '/dataModel/version'],
    [{ id: 'ah2d.ecs', version: 1, componentSchemaVersion: 2 }, 'E_FUTURE_COMPONENT_SCHEMA_VERSION', '/dataModel/componentSchemaVersion']
  ]) {
    assert.throws(
      () => engine.load({ dataModel, scene: [] }),
      error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === code && error.pointer === pointer
    );
  }
  assert.strictEqual(JSON.stringify(engine.document), beforeDocument);
  assert.strictEqual(JSON.stringify(engine.export()), beforeSnapshot);

  const olderDataModel = new AH2D.Engine({ physics: 'builtin' });
  olderDataModel.load({ dataModel: { id: 'ah2d.ecs', version: 0, componentSchemaVersion: 0 }, scene: [] });
  assert.strictEqual(olderDataModel.ecs.entities.size, 0, 'older declared data-model versions remain loadable');

  const generated = new AH2D.Engine({ physics: 'builtin' });
  generated.load({ scene: [{ name: 'Generated ID' }] });
  const generatedId = [...generated.ecs.entities][0];
  assert.strictEqual(generated.document.scene[0].id, generatedId);
  generated.load(generated.document);
  assert.deepStrictEqual([...generated.ecs.entities], [generatedId]);

  const generatedV4 = new AH2D.Engine({ physics: 'builtin' });
  generatedV4.load({ format: 'AH2D', version: 4, currentSceneId: 'main', scenes: [{ id: 'main', objects: [{ name: 'Generated v4 ID' }] }], scene: [] });
  const generatedV4Id = [...generatedV4.ecs.entities][0];
  assert.strictEqual(generatedV4.document.scenes[0].objects[0].id, generatedV4Id);
  assert.strictEqual(generatedV4.document.scene[0].id, generatedV4Id);
};

const testPostProcessProjectContract = () => {
  const defaults = AH2D.createDefaultPostProcess();
  assert.strictEqual(defaults.enabled, true);
  for (const type of ['bloom', 'vignette', 'colorAdjust', 'chromaticAberration', 'pixelate', 'crt']) {
    assert.ok(defaults.effects.some(effect => effect.type === type), `default Post Process stack must include ${type}`);
  }
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ scene: [], postProcess: { enabled: true, effects: [{ id: 'grade', type: 'colorAdjust', name: 'Game Grade', enabled: true, contrast: 1.35 }] } });
  assert.strictEqual(engine.postProcess.get('grade').contrast, 1.35, 'project Post Process settings must load into the Engine');
  engine.postProcess.configure('grade', { saturation: 0.8 });
  assert.strictEqual(engine.postProcess.active.length, 1);
  assert.strictEqual(engine.export().postProcess.effects[0].saturation, 0.8, 'ECS snapshots must expose renderer Post Process data');
  const secondDefaults = AH2D.createDefaultPostProcess();
  secondDefaults.effects[0].intensity = 99;
  assert.notStrictEqual(AH2D.createDefaultPostProcess().effects[0].intensity, 99, 'default stacks must not share mutable state');
};

const testGravityAndSchemaSync = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', physicsOptions: { gravity: { x: 0, y: 12 }, maxStep: 1 } });
  engine.createEntity({
    id: 'falling', x: 4, y: 5,
    rigidbody: {
      type: 'dynamic', mass: 2, gravityScale: 2, linearDamping: 0, angularDamping: 0,
      fixedRotation: false, velocityX: 3, velocityY: 0, angularVelocity: 10
    },
    collider: {
      shape: 'box', width: 20, height: 10, radius: 5, offsetX: 1, offsetY: 2,
      isTrigger: false, restitution: 0.2, friction: 0.4, density: 1
    }
  });
  engine.update(0.25);
  engine.update(0.25);
  const transform = engine.ecs.get('falling', 'Transform');
  const rigidbody = engine.ecs.get('falling', 'Rigidbody');
  near(transform.x, 5.5, 1e-8, 'velocity must sync to Transform');
  near(transform.y, 9.5, 1e-8, 'gravityScale must affect integration');
  near(transform.rotation, 5, 1e-8, 'angular velocity must sync to Transform');
  near(rigidbody.velocity.x, 3);
  near(rigidbody.velocity.y, 12);
  near(rigidbody.inverseMass, 0.5);
  const collider = engine.physics.getBody('falling').colliders[0];
  assert.strictEqual(collider.shape, 'box');
  assert.strictEqual(collider.offsetX, 1);
  assert.strictEqual(collider.offsetY, 2);
};

const testStaticCollisionAndSleeping = () => {
  const engine = new AH2D.Engine({
    physics: 'builtin',
    physicsOptions: { gravity: { x: 0, y: 100 }, maxStep: 1 / 120, timeToSleep: 0.2 }
  });
  engine.createEntity({ id: 'floor', x: 0, y: 100, rigidbody: { type: 'static' }, collider: { shape: 'box', width: 200, height: 20, friction: 0.8 } });
  engine.createEntity({ id: 'ball', x: 0, y: 0, rigidbody: { type: 'dynamic', mass: 1 }, collider: { shape: 'circle', radius: 10, restitution: 0 } });
  let starts = 0;
  engine.events.on('physics:collisionstart', event => { if ([event.a, event.b].includes('ball')) starts += 1; });
  for (let i = 0; i < 240; i += 1) engine.update(1 / 60);
  const body = engine.physics.getBody('ball');
  near(body.position.y, 80.01, 0.03, 'circle must settle on the box surface without tunnelling');
  near(body.velocity.y, 0, 1e-7);
  assert.strictEqual(body.sleeping, true, 'resting dynamic body should sleep');
  assert.strictEqual(starts, 1, 'persistent contact must emit only one collisionstart');
};

const testWideGroundBoxContact = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 980 } });
  engine.createEntity({ id: 'wide-ground', x: 960, y: 930, collider: { shape: 'rectangle', width: 1600, height: 160, friction: 0.75 } });
  engine.createEntity({
    id: 'crate', x: 1470, y: 805,
    rigidbody: { type: 'dynamic', mass: 1, linearDamping: 0.08, angularDamping: 0.12, allowSleep: true },
    collider: { shape: 'rectangle', width: 95, height: 95, friction: 0.55, restitution: 0.08 }
  });
  for (let i = 0; i < 180; i += 1) engine.update(1 / 60);
  const body = engine.physics.getBody('crate');
  near(body.position.y, 802.51, 0.08, 'wide static ground must resolve at the actual overlap location');
  near(body.rotation, 0, 1e-8, 'a centred box contact must not introduce fake torque');
  assert.strictEqual(body.sleeping, true, 'resting box must not jitter forever because of restitution');
};

const testTriggers = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.createEntity({ id: 'sensor', x: 0, y: 0, collider: { shape: 'box', width: 20, height: 20, isTrigger: true } });
  engine.createEntity({ id: 'actor', x: 0, y: 0, rigidbody: { type: 'dynamic', gravityScale: 0 }, collider: { shape: 'circle', radius: 4 } });
  const phases = [];
  engine.events.on('physics:triggerenter', event => phases.push(event.phase));
  engine.events.on('physics:triggerstay', event => phases.push(event.phase));
  engine.events.on('physics:triggerexit', event => phases.push(event.phase));
  engine.update(1 / 60);
  engine.update(1 / 60);
  assert.deepStrictEqual(phases, ['enter', 'stay']);
  engine.ecs.get('actor', 'Transform').x = 100;
  engine.update(1 / 60);
  assert.deepStrictEqual(phases, ['enter', 'stay', 'exit']);
  near(engine.ecs.get('actor', 'Transform').x, 100, 1e-8, 'trigger must not resolve or displace an object');
};

const testAutoMassAndCollisionFilters = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', physicsOptions: { gravity: { x: 0, y: 0 }, pixelsPerMeter: 100 } });
  engine.createEntity({
    id: 'auto-mass', x: 0, y: 0,
    rigidbody: { type: 'dynamic', useAutoMass: true, gravityScale: 0 },
    collider: { shape: 'circle', radius: 50, density: 2, categoryBits: 2, maskBits: 0 }
  });
  engine.createEntity({ id: 'filtered', x: 0, y: 0, collider: { shape: 'box', width: 200, height: 200, categoryBits: 1, maskBits: 0xffff } });
  let contacts = 0;
  engine.events.on('physics:contact', () => { contacts += 1; });
  engine.update(1 / 60);
  const body = engine.physics.getBody('auto-mass');
  near(body.mass, Math.PI * 0.5 * 0.5 * 2, 1e-8, 'auto mass must use collider area in metres squared');
  assert.strictEqual(contacts, 0, 'category and mask filters must suppress excluded contacts');
};

const testKinematicImpulseAndFixedRotation = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 50 } });
  engine.createEntity({ id: 'platform', x: 0, y: 0, rigidbody: { type: 'kinematic', velocityX: 10, velocityY: -2 }, collider: { shape: 'box', width: 10, height: 10 } });
  engine.createEntity({ id: 'locked-spin', x: 100, y: 100, rigidbody: { type: 'dynamic', mass: 2, gravityScale: 0, fixedRotation: true }, collider: { shape: 'box', width: 10, height: 10 } });
  engine.update(0.1);
  near(engine.ecs.get('platform', 'Transform').x, 1);
  near(engine.ecs.get('platform', 'Transform').y, -0.2);
  assert.strictEqual(engine.physics.applyImpulse('locked-spin', { x: 8, y: 0 }, null, { x: 100, y: 110 }), true);
  engine.physics.applyTorque('locked-spin', 1000);
  engine.update(0.25);
  near(engine.ecs.get('locked-spin', 'Transform').x, 101, 1e-8, 'impulse must use inverse mass');
  near(engine.ecs.get('locked-spin', 'Transform').rotation, 0, 1e-8, 'fixedRotation must reject angular changes');
};

const testSnapshotRestore = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 }, runtime: 'custom' });
  engine.createEntity({ id: 'play-object', x: 10, y: 20, rigidbody: { type: 'dynamic', velocityX: 5, velocityY: 0 }, collider: { shape: 'circle', radius: 2 } });
  engine.start(null, { restoreOnStop: true });
  for (let i = 0; i < 4; i += 1) engine.update(0.25);
  near(engine.ecs.get('play-object', 'Transform').x, 15);
  engine.stop();
  near(engine.ecs.get('play-object', 'Transform').x, 10, 1e-8, 'Stop must restore the pre-play snapshot');
  near(engine.ecs.get('play-object', 'Rigidbody').velocityX, 5, 1e-8, 'original Rigidbody schema must survive restore');
};

const testPauseResumeKeepsSimulationState = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 }, runtime: 'custom' });
  engine.createEntity({ id: 'runner', x: 0, y: 0, rigidbody: { type: 'dynamic', velocityX: 8 }, collider: { shape: 'circle', radius: 2 } });
  engine.start(null, { restoreOnStop: true });
  engine.update(0.25);
  engine.pause();
  near(engine.ecs.get('runner', 'Transform').x, 2, 1e-8, 'Pause must preserve the current simulation pose');
  assert.strictEqual(engine.running, false);
  engine.resume();
  engine.update(0.25);
  near(engine.ecs.get('runner', 'Transform').x, 4, 1e-8, 'Resume must continue from the paused pose');
  engine.stop();
  near(engine.ecs.get('runner', 'Transform').x, 0, 1e-8, 'Stop after Resume must still restore the edit snapshot');
};

const testNativeBox2DPath = () => {
  class FakeBody {
    constructor(definition) { this.position = { ...definition.position }; this.velocity = { x: 0, y: 0 }; this.angle = definition.angle; this.angular = 0; this.awake = true; }
    createFixture() { return { setUserData() {} }; }
    setUserData() {}
    setTransform(position, angle) { this.position = { ...position }; this.angle = angle; }
    setLinearVelocity(velocity) { this.velocity = { ...velocity }; }
    setAngularVelocity(value) { this.angular = value; }
    setGravityScale(value) { this.gravityScale = value; }
    setFixedRotation() {}
    setAwake(value) { this.awake = value; }
    getPosition() { return this.position; }
    getLinearVelocity() { return this.velocity; }
    getAngle() { return this.angle; }
    getAngularVelocity() { return this.angular; }
    isAwake() { return this.awake; }
  }
  class FakeWorld {
    constructor(gravity) { this.gravity = gravity; this.bodies = []; }
    createBody(definition) { const body = new FakeBody(definition); this.bodies.push(body); return body; }
    destroyBody(body) { this.bodies = this.bodies.filter(value => value !== body); }
    step(dt) { this.bodies.forEach(body => { body.position.x += body.velocity.x * dt; body.position.y += body.velocity.y * dt; body.angle += body.angular * dt; }); }
    setGravity(value) { this.gravity = value; }
  }
  const fakeBox2D = {
    World: FakeWorld,
    Vec2: (x, y) => ({ x, y }),
    Circle: (offset, radius) => ({ offset, radius }),
    Box: (halfX, halfY, offset, angle) => ({ halfX, halfY, offset, angle })
  };
  const adapter = new AH2D.Box2DPhysicsAdapter(fakeBox2D, { pixelsPerMeter: 10, gravity: { x: 0, y: 20 } });
  const engine = new AH2D.Engine({ physics: adapter });
  engine.createEntity({ id: 'native', x: 20, y: 0, rigidbody: { type: 'dynamic', velocityX: 10, velocityY: 0 }, collider: { shape: 'circle', radius: 5 } });
  engine.update(0.25);
  engine.update(0.25);
  assert.strictEqual(adapter.backend, 'box2d');
  assert.strictEqual(adapter.usingNative, true);
  near(adapter.world.gravity.y, 2, 1e-8, 'native Box2D gravity must be converted from pixels to metres');
  near(engine.ecs.get('native', 'Transform').x, 25, 1e-8, 'native Box2D positions must convert through pixelsPerMeter');
};

const testEditorRuntimeContract = () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'AH2DEdtior.html'), 'utf8');
  for (const id of ['runtimeSelect', 'editorPlay', 'editorPause', 'editorStop', 'runtimeBackend', 'addComponentBtn', 'sceneSelect', 'newSceneBtn', 'saveSceneBtn', 'sceneModal', 'postProcessBtn', 'postProcessPanel', 'postProcessList', 'postProcessReset']) {
    assert.ok(html.includes(`id="${id}"`), `editor runtime control #${id} is missing`);
  }
  for (const token of ['data-add-component="rigidbody"', 'data-add-component="box-collider"', 'data-add-component="circle-collider"', 'ah2dEngine.pause()', 'ah2dEngine.resume()', 'pullSceneTransformsFromEngine()', 'function switchScene(', 'function createScene(', 'function saveCurrentScene()', 'currentSceneId:state.currentSceneId', 'scenes,scene:', 'dataModel:{...dataModelDescriptor}', "componentSchemas.create('Rigidbody'", 'writeEditorComponent(', 'postProcess:cloneData(state.postProcess)', 'function applyScenePostProcess(']) {
    assert.ok(html.includes(token), `editor integration token is missing: ${token}`);
  }
  const dataModelScript = html.indexOf('./engine/AH2DDataModel.js'), engineScript = html.indexOf('./engine/AH2DEngine.js');
  assert.ok(dataModelScript >= 0 && engineScript > dataModelScript, 'DataModel must load before the Engine');
  assert.ok(!html.includes('fallbackPhysicsSubstep'), 'editor must not run a second competing physics solver');
  assert.ok(html.includes("renderer:state.runtime"), 'Universal JSON must persist the selected runtime');
};

testSceneGraphAndRuntimes();
testUnifiedComponentSchemas();
testEntityValidationBeforeRuntimeClone();
testDistinctColliderComponents();
testMultiSceneLoading();
testAtomicLoadValidation();
testPostProcessProjectContract();
testGravityAndSchemaSync();
testStaticCollisionAndSleeping();
testWideGroundBoxContact();
testTriggers();
testAutoMassAndCollisionFilters();
testKinematicImpulseAndFixedRotation();
testSnapshotRestore();
testPauseResumeKeepsSimulationState();
testNativeBox2DPath();
testEditorRuntimeContract();
console.log('AH2D Engine tests passed');
