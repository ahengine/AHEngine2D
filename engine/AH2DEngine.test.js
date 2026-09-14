global.window = global;
global.requestAnimationFrame = () => 101;
global.cancelAnimationFrame = () => {};
require('./AH2DEngine.js');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
  assert.strictEqual(engine.physics.backend, 'box2d', 'the installed Planck dependency must be selected by default');
  assert.strictEqual(engine.physics.implementation, 'planck');
  assert.strictEqual(engine.physics.status, 'ready');
  assert.strictEqual(engine.physics.native, true);
  const fallback = new AH2D.Box2DPhysicsAdapter(null);
  assert.strictEqual(fallback.backend, 'builtin', 'an explicit missing native API must retain the deterministic fallback');
  assert.strictEqual(fallback.implementation, 'ah2d-builtin');
  assert.strictEqual(fallback.status, 'fallback');
  assert.strictEqual(fallback.native, false);
  const explicitBuiltin = new AH2D.Engine({ physics: 'builtin' });
  assert.strictEqual(explicitBuiltin.physics.backend, 'builtin');
  assert.strictEqual(explicitBuiltin.physics.implementation, 'ah2d-builtin');
  assert.strictEqual(explicitBuiltin.physics.status, 'ready');
  assert.strictEqual(explicitBuiltin.physics.native, false);
  const incompatible = new AH2D.Box2DPhysicsAdapter({ World: class LegacyWorld {} });
  assert.strictEqual(incompatible.backend, 'builtin', 'an uppercase/legacy Box2D surface must not be mistaken for Planck');
  assert.strictEqual(incompatible.usingNative, false);
};


const matrixNear = (actual, expected, epsilon = 1e-8, message = 'matrix') => {
  assert.strictEqual(actual.length, 6, message + ' must have six entries');
  expected.forEach((value, index) => near(actual[index], value, epsilon, message + '[' + index + ']'));
};

const testNestedSceneGraphTransforms = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ scene: [
    { id: 'leaf', parentId: 'mid', x: 4, y: 3, rot: 15, sx: 2, sy: 0.5 },
    { id: 'parent', x: 10, y: 20, rot: 90, sx: 2, sy: 2 },
    { id: 'mid', parentId: 'parent', x: 5, y: 0, rot: -30, sx: 0.5, sy: 1 },
    { id: 'sibling', parentId: 'parent', x: -2, y: 1 }
  ] });

  const expected = AH2D.Matrix2D.multiply(
    AH2D.Matrix2D.multiply(
      AH2D.Matrix2D.compose(10, 20, 90, 2, 2),
      AH2D.Matrix2D.compose(5, 0, -30, 0.5, 1)
    ),
    AH2D.Matrix2D.compose(4, 3, 15, 2, 0.5)
  );
  matrixNear(engine.transform.getWorldMatrix('leaf'), expected, 1e-8, 'deep world');
  assert.deepStrictEqual(engine.graph.traverse('parent'), ['parent', 'mid', 'leaf', 'sibling']);
  assert.deepStrictEqual(engine.graph.traverse('parent', { order: 'post' }), ['leaf', 'mid', 'sibling', 'parent']);
  assert.deepStrictEqual(engine.graph.ancestors('leaf'), ['mid', 'parent']);
  assert.deepStrictEqual(engine.graph.descendants('parent'), ['mid', 'leaf', 'sibling']);
  assert.deepStrictEqual(engine.graph.roots(engine.ecs.entities), ['parent']);

  let leafContext = null;
  engine.graph.traverse('parent', (id, context) => {
    if (id === 'leaf') leafContext = context;
  });
  assert.deepStrictEqual(leafContext, {
    depth: 2,
    parentId: 'mid',
    path: ['parent', 'mid', 'leaf']
  });

  const originalPath = engine.graph.path;
  let pathCalls = 0;
  let firstPath = null;
  let secondPath = null;
  let cachedPathDescriptor = null;
  engine.graph.path = function (...args) {
    pathCalls += 1;
    return originalPath.apply(this, args);
  };
  try {
    engine.graph.traverse('parent', () => {});
    engine.graph.traverse('parent', (id, { depth, parentId }) => {
      assert.ok(Number.isInteger(depth), id + ' depth must remain available without reading path');
      assert.strictEqual(parentId, engine.graph.getParent(id));
    });
    assert.strictEqual(pathCalls, 0, 'no-op/depth-only visitors must not resolve traversal paths');
    engine.graph.traverse('parent', (id, context) => {
      if (id !== 'leaf') return;
      assert.ok(Object.keys(context).includes('path'), 'lazy path must remain an enumerable context property');
      firstPath = context.path;
      secondPath = context.path;
      cachedPathDescriptor = Object.getOwnPropertyDescriptor(context, 'path');
    });
  } finally {
    engine.graph.path = originalPath;
  }
  assert.strictEqual(pathCalls, 1, 'an accessed traversal path must resolve exactly once per callback context');
  assert.strictEqual(secondPath, firstPath, 'repeated path reads must return the cached array instance');
  assert.deepStrictEqual(firstPath, ['parent', 'mid', 'leaf']);
  assert.strictEqual(typeof cachedPathDescriptor.get, 'undefined', 'resolved path must become a normal cached value property');

  const local = engine.transform.getLocal('leaf');
  assert.deepStrictEqual(
    { x: local.x, y: local.y, rotation: local.rotation, scaleX: local.scaleX, scaleY: local.scaleY },
    { x: 4, y: 3, rotation: 15, scaleX: 2, scaleY: 0.5 }
  );
  const sourcePoint = { x: 7.5, y: -2.25 };
  const worldPoint = engine.transform.localToWorld('leaf', sourcePoint);
  const roundTrip = engine.transform.worldToLocal('leaf', worldPoint);
  near(roundTrip.x, sourcePoint.x, 1e-8, 'worldToLocal x');
  near(roundTrip.y, sourcePoint.y, 1e-8, 'worldToLocal y');

  engine.ecs.get('parent', 'Transform').x = 17;
  assert.deepStrictEqual(
    engine.transform.update(),
    ['parent', 'mid', 'leaf', 'sibling'],
    'a dirty parent must invalidate its complete subtree in deterministic preorder'
  );
  assert.deepStrictEqual(engine.transform.update(), [], 'clean transforms must not be recomputed');
  const correctLeafWorld = engine.transform.getWorldMatrix('leaf');
  engine.ecs.get('leaf', 'Transform').world[4] = 99999;
  assert.deepStrictEqual(engine.transform.update(), ['leaf'], 'runtime world tampering must be repaired');
  matrixNear(engine.transform.getWorldMatrix('leaf'), correctLeafWorld, 1e-8, 'repaired world');
};

const testReparentAndWorldTransformAPI = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ scene: [
    { id: 'parent-a', x: 30, y: 40, rot: 30, sx: 2, sy: 2 },
    { id: 'parent-b', x: -15, y: 8, rot: -20, sx: 0.5, sy: 0.5 },
    { id: 'child', parentId: 'parent-a', x: 12, y: -4, rot: 10, sx: 1.5, sy: 0.75 }
  ] });

  const originalWorld = engine.transform.getWorldMatrix('child');
  const originalLocal = engine.transform.getLocal('child');
  engine.reparent('child', 'parent-b', { preserveWorld: true });
  assert.strictEqual(engine.graph.getParent('child'), 'parent-b');
  matrixNear(engine.transform.getWorldMatrix('child'), originalWorld, 1e-8, 'preserved reparent world');
  assert.notDeepStrictEqual(engine.transform.getLocal('child').matrix, originalLocal.matrix);

  engine.graph.detach('child', { preserveWorld: true });
  assert.strictEqual(engine.graph.getParent('child'), null);
  matrixNear(engine.transform.getWorldMatrix('child'), originalWorld, 1e-8, 'preserved detach world');

  const detachedLocal = engine.transform.getLocal('child').matrix;
  engine.reparent('child', 'parent-a');
  matrixNear(engine.transform.getLocalMatrix('child'), detachedLocal, 1e-8, 'default reparent preserves local');
  assert.notDeepStrictEqual(engine.transform.getWorldMatrix('child'), originalWorld, 'preserve-local must allow world pose to change');

  engine.reparent('child', 'parent-b');
  const desiredWorld = { x: 110, y: -25, rotation: 12, scaleX: 3, scaleY: 1.5 };
  engine.transform.setWorld('child', desiredWorld);
  const actualWorld = engine.transform.getWorld('child');
  near(actualWorld.x, desiredWorld.x, 1e-8, 'setWorld x');
  near(actualWorld.y, desiredWorld.y, 1e-8, 'setWorld y');
  near(actualWorld.rotation, desiredWorld.rotation, 1e-8, 'setWorld rotation');
  near(actualWorld.scaleX, desiredWorld.scaleX, 1e-8, 'setWorld scaleX');
  near(actualWorld.scaleY, desiredWorld.scaleY, 1e-8, 'setWorld scaleY');
};

const testSetWorldReplacesInheritedShear = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ scene: [
    { id: 'shear-parent', sx: 2, sy: 1 },
    { id: 'shear-child', parentId: 'shear-parent', rot: 45 }
  ] });

  const originalLocal = engine.transform.getLocalMatrix('shear-child');
  const originalWorld = engine.transform.getWorldMatrix('shear-child');
  assert.throws(
    () => engine.transform.setWorld('shear-child', { x: 10, y: 20, rotation: 0, scaleX: 2 }),
    error => error.code === 'E_TRANSFORM_SHEAR',
    'a partial world update must not approximate an omitted scale from a sheared current world'
  );
  matrixNear(engine.transform.getLocalMatrix('shear-child'), originalLocal, 1e-8, 'failed partial setWorld local atomicity');
  matrixNear(engine.transform.getWorldMatrix('shear-child'), originalWorld, 1e-8, 'failed partial setWorld world atomicity');

  const result = engine.transform.setWorld('shear-child', {
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 2,
    scaleY: 1
  });
  matrixNear(engine.transform.getLocalMatrix('shear-child'), AH2D.Matrix2D.compose(0, 0, 0, 1, 1), 1e-8, 'complete setWorld local');
  matrixNear(engine.transform.getWorldMatrix('shear-child'), AH2D.Matrix2D.compose(0, 0, 0, 2, 1), 1e-8, 'complete setWorld world');
  assert.deepStrictEqual(
    { x: result.x, y: result.y, rotation: result.rotation, scaleX: result.scaleX, scaleY: result.scaleY },
    { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 1 }
  );
};

const testAtomicGraphGuards = () => {
  const missingParent = new AH2D.Engine({ physics: 'builtin' });
  assert.throws(
    () => missingParent.createEntity({ id: 'orphan', parentId: 'missing' }),
    error => error.code === 'E_DANGLING_PARENT'
  );
  assert.strictEqual(missingParent.ecs.entities.size, 0);
  assert.strictEqual(missingParent.graph.nodes.size, 0);

  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ scene: [
    { id: 'child', x: 4, y: 0 },
    { id: 'shear-parent', x: 10, y: 0, rot: 0, sx: 2, sy: 1 },
    { id: 'singular-parent', x: 20, y: 0, sx: 0, sy: 1 }
  ] });
  engine.transform.setLocal('child', { rotation: 45 });
  const originalLocal = engine.transform.getLocalMatrix('child');
  const originalWorld = engine.transform.getWorldMatrix('child');

  assert.throws(
    () => engine.reparent('child', 'shear-parent', { preserveWorld: true }),
    error => error.code === 'E_TRANSFORM_SHEAR'
  );
  assert.strictEqual(engine.graph.getParent('child'), null);
  matrixNear(engine.transform.getLocalMatrix('child'), originalLocal, 1e-8, 'shear failure local');
  matrixNear(engine.transform.getWorldMatrix('child'), originalWorld, 1e-8, 'shear failure world');

  assert.throws(
    () => engine.reparent('child', 'singular-parent', { preserveWorld: true }),
    error => error.code === 'E_NON_INVERTIBLE_TRANSFORM'
  );
  assert.strictEqual(engine.graph.getParent('child'), null);
  matrixNear(engine.transform.getLocalMatrix('child'), originalLocal, 1e-8, 'singular failure local');

  assert.throws(
    () => engine.graph.attach('child', 'missing'),
    error => error.code === 'E_DANGLING_PARENT'
  );
  assert.strictEqual(engine.graph.getParent('child'), null);

  engine.graph.attach('child', 'shear-parent');
  const childLocal = engine.transform.getLocalMatrix('child');
  assert.throws(
    () => engine.graph.attach('shear-parent', 'child'),
    error => error.code === 'E_GRAPH_CYCLE'
  );
  assert.strictEqual(engine.graph.getParent('shear-parent'), null);
  assert.strictEqual(engine.graph.getParent('child'), 'shear-parent');
  matrixNear(engine.transform.getLocalMatrix('child'), childLocal, 1e-8, 'cycle failure local');
};

const testDestroyPolicies = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ scene: [
    { id: 'root', x: 100, y: 0 },
    { id: 'group', parentId: 'root', x: 20, y: 0 },
    { id: 'child', parentId: 'group', x: 5, y: 0 },
    { id: 'grandchild', parentId: 'child', x: 2, y: 0 },
    { id: 'branch', parentId: 'root', x: -10, y: 0 },
    { id: 'branch-leaf', parentId: 'branch', x: 1, y: 0, collider: { shape: 'box', width: 4, height: 4 } }
  ] });
  engine.update(0);
  assert.ok(engine.physics.getBody('branch-leaf'));

  assert.throws(
    () => engine.destroyEntity('group'),
    error => error.code === 'E_GRAPH_HAS_CHILDREN'
  );
  assert.ok(engine.ecs.entities.has('group'));
  assert.strictEqual(engine.graph.getParent('child'), 'group');

  const childWorld = engine.transform.getWorldMatrix('child');
  assert.deepStrictEqual(
    engine.destroyEntity('group', { childPolicy: 'reparent', preserveWorld: true }),
    ['group']
  );
  assert.ok(!engine.ecs.entities.has('group'));
  assert.strictEqual(engine.graph.getParent('child'), 'root');
  assert.strictEqual(engine.graph.getParent('grandchild'), 'child');
  matrixNear(engine.transform.getWorldMatrix('child'), childWorld, 1e-8, 'remove/reparent preserved child world');

  assert.throws(
    () => engine.ecs.destroy('root'),
    error => error.code === 'E_GRAPH_HAS_CHILDREN'
  );
  assert.ok(engine.ecs.entities.has('root'), 'unsafe low-level destroy must be atomic');

  assert.deepStrictEqual(
    engine.destroyEntity('branch', { childPolicy: 'cascade' }),
    ['branch-leaf', 'branch'],
    'cascade must destroy descendants child-first'
  );
  assert.ok(!engine.ecs.entities.has('branch'));
  assert.ok(!engine.ecs.entities.has('branch-leaf'));
  assert.strictEqual(engine.physics.getBody('branch-leaf'), null);

  const grandchildWorld = engine.transform.getWorldMatrix('grandchild');
  engine.destroyEntity('child', { childPolicy: 'detach', preserveWorld: true });
  assert.strictEqual(engine.graph.getParent('grandchild'), null);
  matrixNear(engine.transform.getWorldMatrix('grandchild'), grandchildWorld, 1e-8, 'detach policy preserved child world');
};

const testNestedPhysicsUsesWorldTransform = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.load({ scene: [
    { id: 'moving-parent', x: 10, y: 20, rot: 90 },
    {
      id: 'nested-collider',
      parentId: 'moving-parent',
      x: 5,
      y: 0,
      collider: { shape: 'box', width: 10, height: 10 }
    }
  ] });
  engine.update(0);
  let body = engine.physics.getBody('nested-collider');
  near(body.position.x, 10, 1e-8, 'nested physics initial world x');
  near(body.position.y, 25, 1e-8, 'nested physics initial world y');

  engine.ecs.get('moving-parent', 'Transform').rotation = 180;
  engine.ecs.get('moving-parent', 'Transform').x = 40;
  engine.update(0);
  body = engine.physics.getBody('nested-collider');
  near(body.position.x, 35, 1e-8, 'parent mutation must update nested physics world x');
  near(body.position.y, 20, 1e-8, 'parent mutation must update nested physics world y');
};
const testNestedDynamicPhysicsMatrixSync = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.load({ scene: [
    { id: 'scaled-parent', x: 10, y: -4, rot: 30, sx: -2, sy: 1.5 },
    {
      id: 'dynamic-child',
      parentId: 'scaled-parent',
      x: 3,
      y: 5,
      rot: 20,
      sx: 0.75,
      sy: 1.25,
      rigidbody: { type: 'dynamic', gravityScale: 0, velocityX: 8, velocityY: 0 },
      collider: { shape: 'box', width: 2, height: 2 }
    }
  ] });
  const initialLocal = engine.transform.getLocalMatrix('dynamic-child');
  const initialWorld = engine.transform.getWorldMatrix('dynamic-child');

  engine.update(0);
  matrixNear(engine.transform.getLocalMatrix('dynamic-child'), initialLocal, 1e-8, 'zero-step local');
  matrixNear(engine.transform.getWorldMatrix('dynamic-child'), initialWorld, 1e-8, 'zero-step world');

  engine.update(0.25);
  const movedLocal = engine.transform.getLocalMatrix('dynamic-child');
  const movedWorld = engine.transform.getWorldMatrix('dynamic-child');
  matrixNear([...movedLocal.slice(0, 4), 0, 0], [...initialLocal.slice(0, 4), 0, 0], 1e-8, 'physics must preserve local linear transform');
  matrixNear([...movedWorld.slice(0, 4), 0, 0], [...initialWorld.slice(0, 4), 0, 0], 1e-8, 'physics must preserve world linear transform');
  near(movedWorld[4], initialWorld[4] + 2, 1e-8, 'physics moves in world x');
  near(movedWorld[5], initialWorld[5], 1e-8, 'physics preserves world y');

  const rotating = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  rotating.load({ scene: [
    { id: 'nonuniform-parent', rot: 30, sx: -2, sy: 1.5 },
    {
      id: 'rotating-child',
      parentId: 'nonuniform-parent',
      rot: 20,
      rigidbody: { type: 'dynamic', gravityScale: 0, angularVelocity: 10 },
      collider: { shape: 'box', width: 2, height: 2 }
    }
  ] });
  assert.throws(
    () => rotating.update(0.25),
    error => error.code === 'E_TRANSFORM_SHEAR',
    'unrepresentable nested physics rotation must fail explicitly instead of corrupting local TRS'
  );
};

const testNegativeScaleTransformRepresentation = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.createEntity({ id: 'mirrored' });
  engine.transform.setWorld('mirrored', { x: 1, y: 2, rotation: 0, scaleX: -2, scaleY: 3 });
  const local = engine.transform.getLocal('mirrored');
  const world = engine.transform.getWorld('mirrored');
  assert.deepStrictEqual(
    { x: local.x, y: local.y, rotation: local.rotation, scaleX: local.scaleX, scaleY: local.scaleY },
    { x: 1, y: 2, rotation: 0, scaleX: -2, scaleY: 3 }
  );
  near(world.rotation, 0, 1e-8, 'world reflection rotation');
  near(world.scaleX, -2, 1e-8, 'world reflection scaleX');
  near(world.scaleY, 3, 1e-8, 'world reflection scaleY');
  matrixNear(world.matrix, AH2D.Matrix2D.compose(1, 2, 0, -2, 3), 1e-8, 'world reflection matrix');
};

const testTransactionalEntityLifecycle = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.events.on('entity:create', id => {
    if (id === 'listener-failure') throw new Error('listener failed');
  });
  assert.throws(() => engine.createEntity({ id: 'listener-failure' }), /listener failed/);
  assert.strictEqual(engine.ecs.entities.has('listener-failure'), false);
  assert.strictEqual(engine.graph.has('listener-failure'), false);

  engine.createEntity({ id: 'kept' });
  assert.throws(
    () => engine.graph.add('ghost'),
    error => error.code === 'E_GRAPH_ENTITY_MISSING'
  );
  assert.throws(
    () => engine.graph.remove('kept', { childPolicy: 'detach' }),
    error => error.code === 'E_GRAPH_LIFECYCLE'
  );
  assert.strictEqual(engine.ecs.entities.has('kept'), true);
  assert.strictEqual(engine.graph.has('kept'), true);
};

const testDeepHierarchyTraversal = () => {
  const depth = 10000;
  const scene = Array.from({ length: depth }, (_, index) => ({
    id: 'deep-' + index,
    parentId: index ? 'deep-' + (index - 1) : null,
    x: 1,
    y: 0
  }));
  const engine = new AH2D.Engine({ physics: 'builtin' });
  const originalIsDescendant = AH2D.SceneGraph.prototype.isDescendant;
  let stagedAncestorWalks = 0;
  AH2D.SceneGraph.prototype.isDescendant = function (...args) {
    stagedAncestorWalks += 1;
    return originalIsDescendant.apply(this, args);
  };
  try {
    engine.load({ scene });
  } finally {
    AH2D.SceneGraph.prototype.isDescendant = originalIsDescendant;
  }
  assert.strictEqual(
    stagedAncestorWalks,
    0,
    'bulk load must validate the complete parent forest without an ancestor walk for every edge'
  );
  const leaf = 'deep-' + (depth - 1);
  near(engine.transform.getWorldMatrix(leaf)[4], depth, 1e-8, 'deep nested world x');
  assert.strictEqual(engine.graph.traverse('deep-0').length, depth);
  assert.strictEqual(engine.graph.descendants('deep-0').length, depth - 1);
  assert.strictEqual(engine.graph.ancestors(leaf).length, depth - 1);
  const path = engine.graph.path(leaf);
  assert.strictEqual(path.length, depth);
  assert.strictEqual(path[0], 'deep-0');
  assert.strictEqual(path[path.length - 1], leaf);
};

const testTransformRemovalInvalidatesDescendants = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ scene: [
    { id: 'transform-root', x: 10, y: 20 },
    { id: 'transform-bridge', parentId: 'transform-root', x: 5, y: 6 },
    { id: 'transform-leaf', parentId: 'transform-bridge', x: 2, y: 3 }
  ] });
  near(engine.transform.getWorldMatrix('transform-leaf')[4], 17, 1e-8, 'world before Transform removal x');
  near(engine.transform.getWorldMatrix('transform-leaf')[5], 29, 1e-8, 'world before Transform removal y');

  engine.ecs.remove('transform-bridge', 'Transform');
  assert.deepStrictEqual(
    engine.transform.update(),
    ['transform-leaf'],
    'removing an ancestor Transform must dirty and recompute its transformed descendants'
  );
  near(engine.transform.getWorldMatrix('transform-leaf')[4], 12, 1e-8, 'world after Transform removal x');
  near(engine.transform.getWorldMatrix('transform-leaf')[5], 23, 1e-8, 'world after Transform removal y');
  matrixNear(
    engine.transform.getWorldMatrix('transform-bridge'),
    engine.transform.getWorldMatrix('transform-root'),
    1e-8,
    'transformless node inherits its nearest ancestor world matrix'
  );
  engine.createEntity({ id: 'preserved-under-bridge', x: 50, y: 70 });
  engine.reparent('preserved-under-bridge', 'transform-bridge', { preserveWorld: true });
  matrixNear(engine.transform.getWorldMatrix('preserved-under-bridge'), AH2D.Matrix2D.compose(50, 70), 1e-8, 'preserve world under transformless parent');
};

const testHugeTranslationShearGuard = () => {
  assert.throws(
    () => AH2D.Matrix2D.decompose([1, 0, 1, 1, 1e12, -1e12], { strict: true }),
    error => error.code === 'E_TRANSFORM_SHEAR',
    'large translation values must not dilute linear shear residuals'
  );
};

const testChildFirstNestedDynamicPhysics = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.load({ scene: [
    {
      id: 'physics-child',
      parentId: 'physics-parent',
      x: 20,
      y: 0,
      rigidbody: { type: 'dynamic', gravityScale: 0, velocityX: 10, velocityY: 0 }
    },
    {
      id: 'physics-parent',
      x: 100,
      y: 0,
      rigidbody: { type: 'dynamic', gravityScale: 0, velocityX: 10, velocityY: 0 }
    }
  ] });

  engine.update(0.25);
  near(engine.transform.getWorldMatrix('physics-parent')[4], 102.5, 1e-8, 'dynamic parent world x');
  near(engine.transform.getWorldMatrix('physics-child')[4], 122.5, 1e-8, 'dynamic child world x');
  near(engine.transform.getLocal('physics-child').x, 20, 1e-8, 'dynamic child local x');
  near(engine.physics.getBody('physics-parent').position.x, 102.5, 1e-8, 'parent physics pose');
  near(engine.physics.getBody('physics-child').position.x, 122.5, 1e-8, 'child physics pose');
};

const testMirroredNestedColliderOffset = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.load({ scene: [
    { id: 'mirror-parent', x: 100, y: 50, sx: -1, sy: 1 },
    {
      id: 'mirror-collider',
      parentId: 'mirror-parent',
      x: 0,
      y: 0,
      collider: { shape: 'circle', radius: 2, offsetX: 0, offsetY: 10 }
    }
  ] });
  engine.update(0);
  const body = engine.physics.getBody('mirror-collider');
  const shape = engine.physics._worldShape(body, body.colliders[0]);
  near(shape.center.x, 100, 1e-8, 'mirrored collider center x');
  near(shape.center.y, 60, 1e-8, 'mirrored collider center y');
};

const testTransactionalDestroyListenerFailures = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ scene: [
    { id: 'destroy-root', x: 10, y: 0 },
    { id: 'destroy-child', parentId: 'destroy-root', x: 2, y: 0 }
  ] });
  const stopThrowing = engine.events.on('entity:beforeDestroy', id => {
    if (id === 'destroy-child') throw new Error('before destroy failed');
  });
  assert.throws(
    () => engine.destroyEntity('destroy-root', { childPolicy: 'cascade' }),
    /before destroy failed/
  );
  assert.ok(engine.ecs.entities.has('destroy-root'));
  assert.ok(engine.ecs.entities.has('destroy-child'));
  assert.ok(engine.graph.has('destroy-root'));
  assert.ok(engine.graph.has('destroy-child'));
  assert.strictEqual(engine.graph.getParent('destroy-child'), 'destroy-root');
  stopThrowing();
  assert.deepStrictEqual(
    engine.destroyEntity('destroy-root', { childPolicy: 'cascade' }),
    ['destroy-child', 'destroy-root']
  );

  const guarded = new AH2D.Engine({ physics: 'builtin' });
  guarded.createEntity({ id: 'low-level-leaf' });
  assert.throws(
    () => guarded.ecs.destroy('low-level-leaf'),
    error => error.code === 'E_GRAPH_LIFECYCLE'
  );
  assert.ok(guarded.ecs.entities.has('low-level-leaf'));
  assert.ok(guarded.graph.has('low-level-leaf'));

  const committed = new AH2D.Engine({ physics: 'builtin' });
  committed.createEntity({ id: 'post-commit-listener' });
  committed.events.on('graph:remove', () => { throw new Error('graph remove listener failed'); });
  committed.events.on('entity:destroy', () => { throw new Error('entity destroy listener failed'); });
  assert.throws(() => committed.destroyEntity('post-commit-listener'), /graph remove listener failed/);
  assert.strictEqual(committed.ecs.entities.has('post-commit-listener'), false);
  assert.strictEqual(committed.graph.has('post-commit-listener'), false);
};

const testDestroyCommitSurvivesCollisionEndListener = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.load({ scene: [
    { id: 'contact-root', x: 0, y: 0, collider: { shape: 'circle', radius: 8 } },
    { id: 'contact-child', parentId: 'contact-root', x: 0, y: 0, collider: { shape: 'circle', radius: 4 } }
  ] });
  engine.update(1 / 60);
  assert.ok(engine.physics.contacts.size > 0, 'destroy regression requires an active contact');

  const destroyed = [];
  let treeEvents = 0;
  engine.events.on('physics:collisionend', () => { throw new Error('collision end listener failed'); });
  engine.events.on('entity:destroy', id => destroyed.push(id));
  engine.events.on('entity:destroyTree', () => { treeEvents += 1; });

  assert.throws(
    () => engine.destroyEntity('contact-root', { childPolicy: 'cascade' }),
    /collision end listener failed/
  );
  assert.deepStrictEqual(destroyed, ['contact-child', 'contact-root'], 'entity events continue after a collision listener fails');
  assert.strictEqual(treeEvents, 1, 'tree completion event still dispatches after a listener failure');
  for (const id of ['contact-root', 'contact-child']) {
    assert.strictEqual(engine.ecs.entities.has(id), false, id + ' ECS state must be committed');
    assert.strictEqual(engine.graph.has(id), false, id + ' graph state must be committed');
    assert.strictEqual(engine.physics.getBody(id), null, id + ' physics body must be committed');
  }
  assert.strictEqual(engine.physics.contacts.size, 0, 'destroy must synchronously purge body contacts');
};

const testDestroyReentryGuards = () => {
  const lowLevel = new AH2D.Engine({ physics: 'builtin' });
  lowLevel.load({ scene: [
    { id: 'guard-root' },
    { id: 'guard-child', parentId: 'guard-root' }
  ] });
  let lowLevelError = null;
  const stopLowLevel = lowLevel.events.on('entity:beforeDestroy', id => {
    if (id !== 'guard-child') return;
    try { lowLevel.ecs.destroy(id); } catch (error) { lowLevelError = error; throw error; }
  });
  assert.throws(
    () => lowLevel.destroyEntity('guard-root', { childPolicy: 'cascade' }),
    error => error.code === 'E_GRAPH_LIFECYCLE'
  );
  assert.strictEqual(lowLevelError?.code, 'E_GRAPH_LIFECYCLE');
  assert.ok(lowLevel.ecs.entities.has('guard-root') && lowLevel.ecs.entities.has('guard-child'));
  assert.ok(lowLevel.graph.has('guard-root') && lowLevel.graph.has('guard-child'));
  assert.strictEqual(lowLevel.graph.getParent('guard-child'), 'guard-root');
  stopLowLevel();
  assert.deepStrictEqual(lowLevel.destroyEntity('guard-root', { childPolicy: 'cascade' }), ['guard-child', 'guard-root']);

  const nested = new AH2D.Engine({ physics: 'builtin' });
  nested.load({ scene: [
    { id: 'outer-root' },
    { id: 'outer-child', parentId: 'outer-root' },
    { id: 'unrelated' }
  ] });
  const stopNested = nested.events.on('entity:beforeDestroy', id => {
    if (id === 'outer-child') nested.destroyEntity('unrelated');
  });
  assert.throws(
    () => nested.destroyEntity('outer-root', { childPolicy: 'cascade' }),
    error => error.code === 'E_ENTITY_DESTROY_REENTRY'
  );
  for (const id of ['outer-root', 'outer-child', 'unrelated']) {
    assert.ok(nested.ecs.entities.has(id), id + ' ECS state must survive preflight reentry');
    assert.ok(nested.graph.has(id), id + ' graph state must survive preflight reentry');
  }
  assert.strictEqual(nested.graph.getParent('outer-child'), 'outer-root');
  stopNested();
  assert.deepStrictEqual(nested.destroyEntity('outer-root', { childPolicy: 'cascade' }), ['outer-child', 'outer-root']);
  assert.deepStrictEqual(nested.destroyEntity('unrelated'), ['unrelated'], 'transaction guard must reset after completion');
};

const testStaticColliderFollowsDynamicParentSameFrame = () => {
  const engine = new AH2D.Engine({
    physics: 'builtin',
    physicsOptions: { gravity: { x: 0, y: 0 }, maxStep: 0.25 }
  });
  engine.load({ scene: [
    {
      id: 'dynamic-collider-parent',
      x: 0,
      y: 0,
      rigidbody: { type: 'dynamic', gravityScale: 0, velocityX: 40, velocityY: 0 }
    },
    {
      id: 'inherited-static-collider',
      parentId: 'dynamic-collider-parent',
      x: 10,
      y: 0,
      collider: { shape: 'circle', radius: 2 }
    },
    {
      id: 'static-contact-target',
      x: 20,
      y: 0,
      collider: { shape: 'circle', radius: 2 }
    }
  ] });
  engine.update(0);
  assert.strictEqual(engine.physics.contacts.size, 0);

  let starts = 0;
  engine.events.on('physics:collisionstart', event => {
    if ([event.a, event.b].includes('inherited-static-collider') && [event.a, event.b].includes('static-contact-target')) starts += 1;
  });
  engine.update(0.25);

  near(engine.transform.getWorldMatrix('dynamic-collider-parent')[4], 10, 1e-8, 'dynamic parent same-frame world x');
  near(engine.transform.getWorldMatrix('inherited-static-collider')[4], 20, 1e-8, 'static child same-frame world x');
  near(engine.physics.getBody('inherited-static-collider').position.x, 20, 1e-8, 'static child same-frame body x');
  assert.strictEqual(starts, 1, 'collision at the inherited end-of-frame pose must start in the same frame');
  assert.ok(
    [...engine.physics.contacts.values()].some(contact => (
      [contact.bodyA.entityId, contact.bodyB.entityId].includes('inherited-static-collider')
      && [contact.bodyA.entityId, contact.bodyB.entityId].includes('static-contact-target')
    )),
    'contact cache must match the final inherited pose'
  );
};

const testTransformlessColliderInheritsAncestorWorld = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.load({ scene: [
    { id: 'collider-ancestor', x: 40, y: 30, rot: 90, sx: 2, sy: 3 },
    {
      id: 'transformless-collider',
      parentId: 'collider-ancestor',
      x: 99,
      y: 99,
      collider: { shape: 'circle', radius: 2, offsetX: 5, offsetY: 0 }
    }
  ] });
  engine.ecs.remove('transformless-collider', 'Transform');
  engine.update(0);

  const body = engine.physics.getBody('transformless-collider');
  near(body.position.x, 40, 1e-8, 'transformless collider inherited body x');
  near(body.position.y, 30, 1e-8, 'transformless collider inherited body y');
  matrixNear(body._lastWorldWritten, engine.transform.getWorldMatrix('collider-ancestor'), 1e-8, 'transformless collider inherited matrix');
  const shape = engine.physics._worldShape(body, body.colliders[0]);
  near(shape.center.x, 40, 1e-8, 'transformless collider inherited offset x');
  near(shape.center.y, 40, 1e-8, 'transformless collider inherited offset y');
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
    error => error instanceof AH2D.DataModel.ComponentSchemaError
      && error.code === 'E_GRAPH_CYCLE'
      && error.details?.child === 'cycle-b'
      && error.details?.parent === 'cycle-a'
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
    () => engine.load({ scene: [{ id: 'duplicate-load' }, { id: 'duplicate-load' }] }),
    error => error instanceof AH2D.DataModel.ComponentSchemaError && error.code === 'E_ENTITY_EXISTS'
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

const testLoadCommitSurvivesCollisionEndListener = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.load({ scene: [
    { id: 'old-contact-a', x: 0, y: 0, collider: { shape: 'circle', radius: 8 } },
    { id: 'old-contact-b', x: 0, y: 0, collider: { shape: 'circle', radius: 8 } }
  ] });
  engine.update(1 / 60);
  assert.ok(engine.physics.contacts.size > 0, 'load collision regression requires an active old contact');

  const replacement = {
    format: 'AH2D',
    version: 4,
    currentSceneId: 'replacement-scene',
    scenes: [{
      id: 'replacement-scene',
      name: 'Replacement',
      objects: [
        { id: 'replacement-parent', x: 30, y: 4 },
        { id: 'replacement-child', parentId: 'replacement-parent', x: 7, y: 8, collider: { shape: 'box', width: 10, height: 10 } }
      ]
    }],
    scene: []
  };
  const phases = [];
  let coherentDuringEnd = false;
  const stopThrowing = engine.events.on('physics:collisionend', () => {
    phases.push('collisionend');
    coherentDuringEnd = engine.document?.currentSceneId === 'replacement-scene'
      && engine.ecs.entities.has('replacement-child')
      && engine.graph.getParent('replacement-child') === 'replacement-parent'
      && Math.abs(engine.transform.getWorldMatrix('replacement-child')[4] - 37) <= 1e-8
      && engine.physics.bodies.size === 0
      && engine.physics.contacts.size === 0;
    throw new Error('load collision end listener failed');
  });
  engine.events.on('physics:contact', event => { if (event.phase === 'end') phases.push('physics-contact-end'); });
  engine.events.on('postprocess:change', () => phases.push('postprocess'));
  engine.events.on('entity:create', id => phases.push('create:' + id));
  engine.events.on('graph:attach', event => phases.push('attach:' + event.child));
  engine.events.on('transform:update', () => phases.push('transform'));
  engine.events.on('document:load', () => phases.push('document'));
  engine.events.on('scene:change', () => phases.push('scene'));

  assert.throws(() => engine.load(replacement), /load collision end listener failed/);
  assert.strictEqual(coherentDuringEnd, true, 'queued collision-end listeners must observe the coherent replacement state');
  assert.deepStrictEqual([...engine.ecs.entities], ['replacement-parent', 'replacement-child']);
  assert.strictEqual(engine.graph.getParent('replacement-child'), 'replacement-parent');
  near(engine.transform.getWorldMatrix('replacement-child')[4], 37, 1e-8, 'replacement world x after collision listener failure');
  near(engine.transform.getWorldMatrix('replacement-child')[5], 12, 1e-8, 'replacement world y after collision listener failure');
  assert.strictEqual(engine.document.currentSceneId, 'replacement-scene');
  assert.deepStrictEqual(engine.document.scene, engine.document.scenes[0].objects);
  assert.strictEqual(engine.physics.bodies.size, 0, 'old physics bodies must be fully cleared before load events');
  assert.strictEqual(engine.physics.contacts.size, 0, 'old contacts must be fully cleared before load events');
  for (const phase of [
    'collisionend', 'physics-contact-end', 'postprocess',
    'create:replacement-parent', 'attach:replacement-parent',
    'create:replacement-child', 'attach:replacement-child',
    'transform', 'document', 'scene'
  ]) assert.ok(phases.includes(phase), 'load must continue lifecycle phase after listener failure: ' + phase);

  stopThrowing();
  engine.update(0);
  assert.strictEqual(engine.physics.getBody('old-contact-a'), null);
  assert.strictEqual(engine.physics.getBody('old-contact-b'), null);
  assert.ok(engine.physics.getBody('replacement-child'), 'replacement physics must synchronize normally after the failed listener is removed');
};

const testLoadCommitSurvivesEntityCreateListener = () => {
  const engine = new AH2D.Engine({ physics: 'builtin', gravity: { x: 0, y: 0 } });
  engine.load({ scene: [{ id: 'stale-body', collider: { shape: 'box', width: 20, height: 20 } }] });
  engine.update(0);
  assert.ok(engine.physics.getBody('stale-body'));

  const replacement = {
    format: 'AH2D',
    version: 4,
    currentSceneId: 'listener-scene',
    scenes: [{
      id: 'listener-scene',
      name: 'Listener Scene',
      objects: [
        { id: 'listener-parent', x: 100, y: 20 },
        { id: 'listener-child', parentId: 'listener-parent', x: 5, y: -3, collider: { shape: 'circle', radius: 3 } }
      ]
    }],
    scene: []
  };
  const phases = [];
  let coherentDuringCreate = false;
  const stopThrowing = engine.events.on('entity:create', id => {
    phases.push('create:' + id);
    if (id !== 'listener-parent') return;
    coherentDuringCreate = engine.document?.currentSceneId === 'listener-scene'
      && engine.ecs.entities.has('listener-child')
      && engine.graph.getParent('listener-child') === 'listener-parent'
      && Math.abs(engine.transform.getWorldMatrix('listener-child')[4] - 105) <= 1e-8
      && engine.physics.getBody('stale-body') === null;
    throw new Error('load entity create listener failed');
  });
  engine.events.on('graph:attach', event => phases.push('attach:' + event.child));
  engine.events.on('transform:update', () => phases.push('transform'));
  engine.events.on('document:load', () => { phases.push('document'); throw new Error('later document listener failed'); });
  engine.events.on('scene:change', () => phases.push('scene'));

  assert.throws(() => engine.load(replacement), /load entity create listener failed/);
  assert.strictEqual(coherentDuringCreate, true, 'entity:create listeners must observe fully synchronized replacement state');
  assert.deepStrictEqual([...engine.ecs.entities], ['listener-parent', 'listener-child']);
  assert.strictEqual(engine.graph.getParent('listener-child'), 'listener-parent');
  near(engine.transform.getWorldMatrix('listener-child')[4], 105, 1e-8, 'replacement world x after create listener failure');
  near(engine.transform.getWorldMatrix('listener-child')[5], 17, 1e-8, 'replacement world y after create listener failure');
  assert.strictEqual(engine.document.currentSceneId, 'listener-scene');
  assert.strictEqual(engine.physics.getBody('stale-body'), null, 'stale physics must not survive a create listener failure');
  for (const phase of [
    'create:listener-parent', 'attach:listener-parent',
    'create:listener-child', 'attach:listener-child',
    'transform', 'document', 'scene'
  ]) assert.ok(phases.includes(phase), 'load must continue lifecycle phase after entity:create failure: ' + phase);

  stopThrowing();
  engine.update(0);
  assert.ok(engine.physics.getBody('listener-child'), 'replacement collider must remain usable after a committed load error');
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
    constructor(definition) {
      this.definition = { ...definition };
      this.position = { ...definition.position };
      this.velocity = { x: 0, y: 0 };
      this.angle = definition.angle;
      this.angular = 0;
      this.awake = true;
      this.active = definition.active !== false;
      this.enabled = definition.enabled !== false;
      this.fixtures = [];
    }
    createFixture(shape, definition) {
      const fixture = { shape, definition, setUserData(value) { this.userData = value; } };
      this.fixtures.push(fixture);
      return fixture;
    }
    setUserData() {}
    setTransform(position, angle) { this.position = { ...position }; this.angle = angle; }
    setLinearVelocity(velocity) { this.velocity = { ...velocity }; }
    setAngularVelocity(value) { this.angular = value; }
    setGravityScale(value) { this.gravityScale = value; }
    setFixedRotation() {}
    setActive(value) { this.active = value; }
    setEnabled(value) { this.enabled = value; }
    setAwake(value) { this.awake = value; }
    getPosition() { return this.position; }
    getLinearVelocity() { return this.velocity; }
    getAngle() { return this.angle; }
    getAngularVelocity() { return this.angular; }
    isAwake() { return this.awake; }
  }
  class FakeWorld {
    constructor(gravity) { this.gravity = gravity; this.bodies = []; this.listeners = new Map(); }
    createBody(definition) { const body = new FakeBody(definition); this.bodies.push(body); return body; }
    destroyBody(body) { this.bodies = this.bodies.filter(value => value !== body); }
    step(dt) { this.bodies.forEach(body => { body.position.x += body.velocity.x * dt; body.position.y += body.velocity.y * dt; body.angle += body.angular * dt; }); }
    setGravity(value) { this.gravity = value; }
    setAutoClearForces() {}
    clearForces() {}
    getContactList() { return null; }
    on(name, listener) { const values = this.listeners.get(name) || new Set(); values.add(listener); this.listeners.set(name, values); }
    off(name, listener) { this.listeners.get(name)?.delete(listener); }
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

  const nestedAdapter = new AH2D.Box2DPhysicsAdapter(fakeBox2D, {
    pixelsPerMeter: 10,
    gravity: { x: 0, y: 0 }
  });
  const nestedEngine = new AH2D.Engine({ physics: nestedAdapter });
  nestedEngine.load({ scene: [
    { id: 'native-parent', x: 100, y: 50, rot: 25, sx: -2, sy: 3 },
    {
      id: 'native-child',
      parentId: 'native-parent',
      x: 4,
      y: -3,
      rot: 15,
      sx: 0.5,
      sy: 1.25,
      rigidbody: { type: 'static', enabled: true },
      collider: {
        shape: 'box',
        width: 8,
        height: 6,
        offsetX: 5,
        offsetY: -2,
        rotation: 27,
        friction: 0.6,
        restitution: 0.25,
        categoryBits: 4,
        maskBits: 12,
        groupIndex: -2
      }
    }
  ] });

  const assertNativeFixtureParity = message => {
    const body = nestedAdapter.getBody('native-child');
    const nativeBody = nestedAdapter.nativeBodies.get('native-child');
    const expected = nestedAdapter._worldShape(body, body.colliders[0]);
    assert.strictEqual(nativeBody.fixtures.length, 1, message + ' fixture count');
    const fixture = nativeBody.fixtures[0];
    const shape = fixture.shape;
    const offsetX = shape.offset.x * nestedAdapter.pixelsPerMeter;
    const offsetY = shape.offset.y * nestedAdapter.pixelsPerMeter;
    const cosine = Math.cos(nativeBody.angle), sine = Math.sin(nativeBody.angle);
    near(
      nativeBody.position.x * nestedAdapter.pixelsPerMeter + cosine * offsetX - sine * offsetY,
      expected.center.x,
      1e-8,
      message + ' world center x'
    );
    near(
      nativeBody.position.y * nestedAdapter.pixelsPerMeter + sine * offsetX + cosine * offsetY,
      expected.center.y,
      1e-8,
      message + ' world center y'
    );
    near(shape.halfX * nestedAdapter.pixelsPerMeter, expected.halfX, 1e-8, message + ' half width');
    near(shape.halfY * nestedAdapter.pixelsPerMeter, expected.halfY, 1e-8, message + ' half height');
    near(Math.cos(nativeBody.angle + shape.angle), Math.cos(expected.angle), 1e-8, message + ' axis cosine');
    near(Math.sin(nativeBody.angle + shape.angle), Math.sin(expected.angle), 1e-8, message + ' axis sine');
    assert.deepStrictEqual(
      {
        friction: fixture.definition.friction,
        restitution: fixture.definition.restitution,
        categoryBits: fixture.definition.filterCategoryBits,
        maskBits: fixture.definition.filterMaskBits,
        groupIndex: fixture.definition.filterGroupIndex
      },
      { friction: 0.6, restitution: 0.25, categoryBits: 4, maskBits: 12, groupIndex: -2 },
      message + ' fixture material/filter'
    );
    return nativeBody;
  };

  nestedEngine.update(0);
  const initialNativeBody = assertNativeFixtureParity('nested reflected fixture');
  nestedEngine.ecs.get('native-parent', 'Transform').x += 20;
  nestedEngine.ecs.get('native-parent', 'Transform').rotation += 10;
  nestedEngine.update(0);
  assert.strictEqual(
    nestedAdapter.nativeBodies.get('native-child'),
    initialNativeBody,
    'world translation/rotation must update the native body pose without rebuilding an unchanged fixture'
  );
  assertNativeFixtureParity('translated/rotated fixture');

  nestedEngine.ecs.get('native-parent', 'Transform').scaleX = -4;
  nestedEngine.update(0);
  const scaledNativeBody = assertNativeFixtureParity('rescaled fixture');
  assert.notStrictEqual(
    scaledNativeBody,
    initialNativeBody,
    'an inherited world-scale change must rebuild native fixture geometry'
  );
  assert.strictEqual(nestedAdapter.world.bodies.length, 1, 'fixture rebuild must remove the obsolete native body');

  nestedEngine.ecs.get('native-child', 'Rigidbody').type = 'dynamic';
  nestedEngine.update(0);
  const dynamicNativeBody = nestedAdapter.nativeBodies.get('native-child');
  assert.notStrictEqual(dynamicNativeBody, scaledNativeBody, 'body type changes must recreate the native body');
  assert.strictEqual(dynamicNativeBody.definition.type, 'dynamic');
  assert.ok(dynamicNativeBody.fixtures[0].definition.density > 0, 'dynamic fixture must receive mass-derived density');

  const nativeRigidbody = nestedEngine.ecs.get('native-child', 'Rigidbody');
  const nativeCollider = nestedEngine.ecs.get('native-child', 'Collider');
  nativeRigidbody.mass = 5;
  nativeCollider.friction = 0.2;
  nativeCollider.restitution = 0.7;
  nativeCollider.categoryBits = 8;
  nativeCollider.maskBits = 3;
  nativeCollider.groupIndex = 2;
  nestedEngine.update(0);
  const editedFixtureBody = nestedAdapter.nativeBodies.get('native-child');
  assert.notStrictEqual(editedFixtureBody, dynamicNativeBody, 'mass/material/filter edits must rebuild native fixtures');
  assert.deepStrictEqual(
    {
      friction: editedFixtureBody.fixtures[0].definition.friction,
      restitution: editedFixtureBody.fixtures[0].definition.restitution,
      categoryBits: editedFixtureBody.fixtures[0].definition.filterCategoryBits,
      maskBits: editedFixtureBody.fixtures[0].definition.filterMaskBits,
      groupIndex: editedFixtureBody.fixtures[0].definition.filterGroupIndex
    },
    { friction: 0.2, restitution: 0.7, categoryBits: 8, maskBits: 3, groupIndex: 2 }
  );
  assert.ok(
    editedFixtureBody.fixtures[0].definition.density > dynamicNativeBody.fixtures[0].definition.density,
    'native fixture density must be rebuilt from the edited Rigidbody mass'
  );

  nativeCollider.enabled = false;
  nestedEngine.update(0);
  const disabledFixtureBody = nestedAdapter.nativeBodies.get('native-child');
  assert.notStrictEqual(disabledFixtureBody, editedFixtureBody, 'collider enabled changes must rebuild native fixtures');
  assert.strictEqual(disabledFixtureBody.fixtures.length, 0, 'disabled colliders must not create native fixtures');

  nativeRigidbody.enabled = false;
  nestedEngine.update(0);
  const disabledBody = nestedAdapter.nativeBodies.get('native-child');
  assert.strictEqual(disabledBody.active, false, 'disabled Rigidbody must deactivate the native body');
  assert.strictEqual(disabledBody.enabled, false, 'disabled Rigidbody must disable the native body');

  nestedEngine.createEntity({
    id: 'native-circle',
    parentId: 'native-parent',
    x: -3,
    y: 2,
    collider: { shape: 'circle', radius: 3, offsetX: -4, offsetY: 6 }
  });
  nestedEngine.update(0);
  const assertNativeCircleParity = message => {
    const body = nestedAdapter.getBody('native-circle');
    const nativeBody = nestedAdapter.nativeBodies.get('native-circle');
    const expected = nestedAdapter._worldShape(body, body.colliders[0]);
    const shape = nativeBody.fixtures[0].shape;
    const offsetX = shape.offset.x * nestedAdapter.pixelsPerMeter;
    const offsetY = shape.offset.y * nestedAdapter.pixelsPerMeter;
    const cosine = Math.cos(nativeBody.angle), sine = Math.sin(nativeBody.angle);
    near(
      nativeBody.position.x * nestedAdapter.pixelsPerMeter + cosine * offsetX - sine * offsetY,
      expected.center.x,
      1e-8,
      message + ' center x'
    );
    near(
      nativeBody.position.y * nestedAdapter.pixelsPerMeter + sine * offsetX + cosine * offsetY,
      expected.center.y,
      1e-8,
      message + ' center y'
    );
    near(shape.radius * nestedAdapter.pixelsPerMeter, expected.radius, 1e-8, message + ' radius');
    return nativeBody;
  };
  const initialCircleBody = assertNativeCircleParity('nested reflected circle');
  nestedEngine.ecs.get('native-parent', 'Transform').scaleY = 5;
  nestedEngine.update(0);
  const scaledCircleBody = assertNativeCircleParity('rescaled circle');
  assert.notStrictEqual(scaledCircleBody, initialCircleBody, 'inherited scale must rebuild native circle geometry');
};

const testRealPlanckForcesConfigurationAndLifecycle = () => {
  const adapter = new AH2D.Box2DPhysicsAdapter(undefined, {
    gravity: { x: 0, y: 0 },
    pixelsPerMeter: 10,
    maxStep: 0.01,
    maxSubSteps: 16,
    velocityIterations: 7,
    positionIterations: 5
  });
  const engine = new AH2D.Engine({ physics: adapter });
  engine.createEntity({
    id: 'force-body',
    x: 20,
    y: 30,
    rigidbody: { type: 'dynamic', mass: 2, gravityScale: 0, allowSleep: false },
    collider: { id: 'force-fixture', shape: 'box', width: 10, height: 20, density: 2 }
  });
  engine.update(0);

  assert.strictEqual(adapter.backend, 'box2d');
  assert.strictEqual(adapter.implementation, 'planck');
  assert.strictEqual(adapter.status, 'ready');
  assert.strictEqual(adapter.native, true);
  assert.strictEqual(adapter.usingNative, true);
  const initialWorld = adapter.getNativeWorld();
  const initialBody = adapter.getNativeBody('force-body');
  const initialFixture = adapter.getNativeFixture('force-body', 'force-fixture');
  assert.ok(initialWorld && initialBody && initialFixture, 'native Planck handles must be available after synchronization');

  const nativeSteps = [];
  const step = initialWorld.step.bind(initialWorld);
  initialWorld.step = (...args) => { nativeSteps.push(args); return step(...args); };
  assert.strictEqual(adapter.applyForce('force-body', 20, 0), true);
  assert.strictEqual(adapter.applyTorque('force-body', 200), true);
  engine.update(0.05);

  assert.strictEqual(nativeSteps.length, 5, 'maxStep must split a long Engine frame into bounded native steps');
  nativeSteps.forEach(args => {
    near(args[0], 0.01, 1e-10, 'native substep duration');
    assert.strictEqual(args[1], 7, 'velocityIterations must reach Planck');
    assert.strictEqual(args[2], 5, 'positionIterations must reach Planck');
  });
  let body = adapter.getBody('force-body');
  near(body.velocity.x, 0.5, 1e-8, 'native force conversion must preserve pixel-space acceleration');
  near(body.velocity.y, 0, 1e-8);
  near(body.angularVelocity, 6.875493541569879, 1e-8, 'native torque conversion must preserve pixel-space inertia');
  assert.deepStrictEqual(body.force, { x: 0, y: 0 }, 'queued force must clear after one Engine step');
  assert.strictEqual(body.torque, 0, 'queued torque must clear after one Engine step');

  const velocityAfterForce = { ...body.velocity };
  const angularAfterTorque = body.angularVelocity;
  engine.update(0.05);
  body = adapter.getBody('force-body');
  near(body.velocity.x, velocityAfterForce.x, 1e-8, 'a queued force must not repeat on later frames');
  near(body.velocity.y, velocityAfterForce.y, 1e-8, 'a queued force must not repeat on later frames');
  near(body.angularVelocity, angularAfterTorque, 1e-8, 'queued torque must not repeat on later frames');

  const velocityBeforeImpulse = body.velocity.x;
  assert.strictEqual(adapter.applyImpulse('force-body', 10, 0), true);
  near(adapter.getBody('force-body').velocity.x, velocityBeforeImpulse + 5, 1e-8, 'native impulse must use pixel-space units');

  const pixelState = {
    position: { ...body.position },
    rotation: body.rotation,
    velocity: { ...body.velocity },
    angularVelocity: body.angularVelocity
  };
  adapter.setPixelsPerMeter(20);
  body = adapter.getBody('force-body');
  assert.strictEqual(adapter.pixelsPerMeter, 20);
  assert.notStrictEqual(adapter.getNativeWorld(), initialWorld, 'changing PPM must rebuild the native World safely');
  assert.notStrictEqual(adapter.getNativeBody('force-body'), initialBody, 'changing PPM must rebuild native bodies');
  assert.notStrictEqual(adapter.getNativeFixture('force-body', 'force-fixture'), initialFixture, 'changing PPM must rebuild fixtures');
  near(body.position.x, pixelState.position.x, 1e-8, 'PPM rebuild must preserve pixel position x');
  near(body.position.y, pixelState.position.y, 1e-8, 'PPM rebuild must preserve pixel position y');
  near(body.rotation, pixelState.rotation, 1e-8, 'PPM rebuild must preserve rotation');
  near(body.velocity.x, pixelState.velocity.x, 1e-8, 'PPM rebuild must preserve pixel velocity x');
  near(body.velocity.y, pixelState.velocity.y, 1e-8, 'PPM rebuild must preserve pixel velocity y');
  near(body.angularVelocity, pixelState.angularVelocity, 1e-8, 'PPM rebuild must preserve angular velocity');
  near(adapter.getNativeBody('force-body').getPosition().x, body.position.x / 20, 1e-8);
  near(adapter.getNativeBody('force-body').getLinearVelocity().x, body.velocity.x / 20, 1e-8);

  const preLoadWorld = adapter.getNativeWorld();
  engine.load({
    engine: {
      physics: 'box2d',
      physicsImplementation: 'planck',
      gravity: { x: 50, y: -100 },
      pixelsPerMeter: 25
    },
    scene: [{
      id: 'configured-body',
      x: 50,
      y: 75,
      rigidbody: { type: 'dynamic', gravityScale: 0 },
      collider: { id: 'configured-fixture', shape: 'circle', radius: 5 }
    }]
  });
  assert.strictEqual(adapter.pixelsPerMeter, 25, 'load must consume project.engine.pixelsPerMeter');
  assert.deepStrictEqual(adapter.gravity, { x: 50, y: -100 }, 'load must consume project.engine.gravity');
  assert.notStrictEqual(adapter.getNativeWorld(), preLoadWorld, 'loading a different PPM must rebuild the World');
  near(adapter.getNativeWorld().getGravity().x, 2, 1e-8, 'document gravity x must be converted to metres');
  near(adapter.getNativeWorld().getGravity().y, -4, 1e-8, 'document gravity y must be converted to metres');
  engine.update(0);
  assert.ok(adapter.getNativeBody('configured-body'));
  assert.ok(adapter.getNativeFixture('configured-body', 'configured-fixture'));
  near(adapter.getNativeBody('configured-body').getPosition().x, 2, 1e-8);
  near(adapter.getNativeBody('configured-body').getPosition().y, 3, 1e-8);

  assert.deepStrictEqual(engine.destroyEntity('configured-body'), ['configured-body']);
  assert.strictEqual(adapter.getBody('configured-body'), null);
  assert.strictEqual(adapter.getNativeBody('configured-body'), null);
  assert.strictEqual(adapter.getNativeFixture('configured-body', 'configured-fixture'), null);
  assert.strictEqual(adapter.getNativeWorld().getBodyCount(), 0, 'destroyEntity must destroy the native Planck body');
};

const testRealPlanckContactsTriggersFilteringAndMass = () => {
  const triggerEngine = new AH2D.Engine({ gravity: { x: 0, y: 0 }, physicsOptions: { pixelsPerMeter: 10 } });
  triggerEngine.createEntity({
    id: 'sensor', x: 0, y: 0,
    collider: { id: 'sensor-fixture', shape: 'box', width: 20, height: 20, isTrigger: true, categoryBits: 2, maskBits: 4 }
  });
  triggerEngine.createEntity({
    id: 'actor', x: 0, y: 0,
    rigidbody: { type: 'dynamic', gravityScale: 0, allowSleep: false },
    collider: { id: 'actor-fixture', shape: 'circle', radius: 4, categoryBits: 4, maskBits: 2 }
  });
  const triggerEvents = [];
  let collisionEvents = 0;
  for (const name of ['physics:triggerenter', 'physics:triggerstay', 'physics:triggerexit']) {
    triggerEngine.events.on(name, event => triggerEvents.push(event));
  }
  triggerEngine.events.on('physics:collisionstart', () => { collisionEvents += 1; });
  triggerEngine.update(1 / 60);
  triggerEngine.update(1 / 60);
  triggerEngine.ecs.get('actor', 'Transform').x = 100;
  triggerEngine.update(1 / 60);
  assert.deepStrictEqual(triggerEvents.map(event => event.phase), ['enter', 'stay', 'exit']);
  assert.strictEqual(collisionEvents, 0, 'a native sensor must emit trigger events rather than collision events');
  for (const event of triggerEvents) {
    assert.deepStrictEqual([event.a, event.b].sort(), ['actor', 'sensor']);
    assert.ok(Number.isFinite(event.point.x) && Number.isFinite(event.point.y), 'native contact point must be finite');
    near(Math.hypot(event.normal.x, event.normal.y), 1, 1e-8, 'native contact normal must be normalized');
  }

  const collisionEngine = new AH2D.Engine({ gravity: { x: 0, y: 0 }, physicsOptions: { pixelsPerMeter: 10 } });
  collisionEngine.createEntity({ id: 'wall', x: 0, y: 0, collider: { id: 'wall-fixture', shape: 'box', width: 20, height: 20 } });
  collisionEngine.createEntity({
    id: 'box', x: 0, y: 10,
    rigidbody: { type: 'dynamic', gravityScale: 0, allowSleep: false },
    collider: { id: 'box-fixture', shape: 'box', width: 10, height: 10 }
  });
  const collisionPhases = [];
  for (const name of ['physics:collisionstart', 'physics:collisionstay', 'physics:collisionend']) {
    collisionEngine.events.on(name, event => collisionPhases.push(event.phase));
  }
  collisionEngine.update(1 / 60);
  collisionEngine.update(1 / 60);
  collisionEngine.ecs.get('box', 'Transform').y = 100;
  collisionEngine.update(1 / 60);
  assert.deepStrictEqual(collisionPhases, ['start', 'stay', 'end'], 'native contacts must drive collision lifecycle events');

  const filteredEngine = new AH2D.Engine({ gravity: { x: 0, y: 0 }, physicsOptions: { pixelsPerMeter: 10 } });
  filteredEngine.createEntity({
    id: 'filtered-dynamic', x: 0, y: 0,
    rigidbody: { type: 'dynamic', gravityScale: 0 },
    collider: { shape: 'box', width: 10, height: 10, categoryBits: 1, maskBits: 0 }
  });
  filteredEngine.createEntity({
    id: 'filtered-static', x: 0, y: 0,
    collider: { shape: 'box', width: 10, height: 10, categoryBits: 2, maskBits: 0xffff }
  });
  let filteredContacts = 0;
  filteredEngine.events.on('physics:contact', () => { filteredContacts += 1; });
  filteredEngine.update(1 / 60);
  assert.strictEqual(filteredContacts, 0, 'Planck category/mask filtering must suppress excluded pairs');
  assert.strictEqual(filteredEngine.physics.contacts.size, 0);

  const staticEngine = new AH2D.Engine({ gravity: { x: 0, y: 0 }, physicsOptions: { pixelsPerMeter: 10 } });
  staticEngine.createEntity({ id: 'static-a', x: 0, y: 0, collider: { shape: 'box', width: 20, height: 20 } });
  staticEngine.createEntity({ id: 'static-b', x: 0, y: 0, collider: { shape: 'box', width: 20, height: 20 } });
  let staticContacts = 0;
  staticEngine.events.on('physics:contact', () => { staticContacts += 1; });
  staticEngine.update(1 / 60);
  assert.strictEqual(staticContacts, 0, 'the native path must not invent static/static contacts with an O(n^2) fallback scan');

  const massEngine = new AH2D.Engine({ gravity: { x: 0, y: 0 }, physicsOptions: { pixelsPerMeter: 10 } });
  massEngine.createEntity({
    id: 'auto-mass-native',
    components: {
      Rigidbody: { type: 'dynamic', useAutoMass: true, gravityScale: 0 },
      BoxCollider: [
        { id: 'solid-mass', width: 10, height: 20, density: 2 },
        { id: 'sensor-mass', width: 100, height: 100, density: 100, isTrigger: true }
      ]
    }
  });
  massEngine.update(0);
  near(massEngine.physics.getBody('auto-mass-native').mass, 4, 1e-8, 'built-in mass projection must exclude sensors');
  near(massEngine.physics.getNativeBody('auto-mass-native').getMass(), 4, 1e-8, 'native Planck mass must exclude sensors');
  near(massEngine.physics.getNativeFixture('auto-mass-native', 'solid-mass').getDensity(), 2, 1e-8);
  near(massEngine.physics.getNativeFixture('auto-mass-native', 'sensor-mass').getDensity(), 0, 1e-8);

  const authoredMassEngine = new AH2D.Engine({ gravity: { x: 0, y: 0 }, physicsOptions: { pixelsPerMeter: 10 } });
  authoredMassEngine.createEntity({
    id: 'body-without-fixtures',
    rigidbody: { type: 'dynamic', mass: 7, gravityScale: 0, allowSleep: false }
  });
  authoredMassEngine.createEntity({
    id: 'body-with-only-sensor',
    rigidbody: { type: 'dynamic', mass: 5, gravityScale: 0, allowSleep: false },
    collider: { id: 'massless-sensor', shape: 'circle', radius: 10, density: 100, isTrigger: true }
  });
  authoredMassEngine.update(0);
  near(authoredMassEngine.physics.getBody('body-without-fixtures').mass, 7, 1e-8, 'a native body without fixtures must preserve authored mass');
  near(authoredMassEngine.physics.getNativeBody('body-without-fixtures').getMass(), 7, 1e-8, 'Planck must receive authored mass without fixtures');
  near(authoredMassEngine.physics.getBody('body-with-only-sensor').mass, 5, 1e-8, 'a sensor-only native body must preserve authored mass');
  near(authoredMassEngine.physics.getNativeBody('body-with-only-sensor').getMass(), 5, 1e-8, 'Planck sensors must not replace authored mass');
  assert.strictEqual(authoredMassEngine.physics.applyImpulse('body-without-fixtures', 14, 0), true);
  near(authoredMassEngine.physics.getBody('body-without-fixtures').velocity.x, 2, 1e-8, 'fixtureless impulse must use authored mass');
};

const testDocumentPhysicsSelectionAndNativeSnapshot = () => {
  const engine = new AH2D.Engine({
    gravity: { x: 0, y: 0 },
    physicsOptions: { pixelsPerMeter: 10 },
    runtime: 'custom'
  });
  assert.strictEqual(engine.physics.name, 'box2d');
  assert.strictEqual(engine.physics.usingNative, true);

  engine.load({
    engine: { physics: 'builtin', gravity: { x: 0, y: 0 }, pixelsPerMeter: 12 },
    scene: [{ id: 'builtin-object', rigidbody: { type: 'dynamic', mass: 3, gravityScale: 0 } }]
  });
  assert.strictEqual(engine.physics.name, 'builtin', 'an unlocked Engine must honor an authored built-in backend');
  assert.strictEqual(engine.physics.implementation, 'ah2d-builtin');
  assert.strictEqual(engine.physics.pixelsPerMeter, 12);

  engine.load({ scene: [] });
  assert.strictEqual(engine.physics.name, 'box2d', 'a legacy project without metadata must return to the documented Box2D default');
  assert.strictEqual(engine.physics.usingNative, true);

  engine.load({
    engine: { physics: 'box2d', gravity: { x: 0, y: 0 }, pixelsPerMeter: 10 },
    scene: [{
      id: 'snapshot-body', x: 30, y: 40,
      rigidbody: { type: 'dynamic', mass: 2, gravityScale: 0, allowSleep: false, velocityX: 8 },
      collider: { id: 'snapshot-fixture', shape: 'box', width: 10, height: 20 }
    }]
  });
  assert.strictEqual(engine.physics.name, 'box2d', 'an unlocked Engine must switch back to native Box2D from project data');
  assert.strictEqual(engine.physics.usingNative, true);
  engine.update(0);
  engine.physics.setTransform('snapshot-body', 55, 65, 12);
  engine.physics.setVelocity('snapshot-body', 9, -4);
  engine.physics.setAngularVelocity('snapshot-body', 15);
  engine.update(0);
  const snapshot = engine.captureSnapshot();

  engine.physics.setPixelsPerMeter(25);
  engine.physics.setTransform('snapshot-body', 500, 600, 90);
  engine.physics.setVelocity('snapshot-body', 0, 0);
  engine.restoreSnapshot(snapshot);
  const restored = engine.physics.getBody('snapshot-body');
  assert.strictEqual(engine.physics.pixelsPerMeter, 10, 'native snapshot restore must restore pixelsPerMeter');
  near(restored.position.x, 55, 1e-8, 'native snapshot restore position x');
  near(restored.position.y, 65, 1e-8, 'native snapshot restore position y');
  near(restored.rotation, 12, 1e-8, 'native snapshot restore rotation');
  near(restored.velocity.x, 9, 1e-8, 'native snapshot restore velocity x');
  near(restored.velocity.y, -4, 1e-8, 'native snapshot restore velocity y');
  near(restored.angularVelocity, 15, 1e-8, 'native snapshot restore angular velocity');
  near(engine.physics.getNativeBody('snapshot-body').getPosition().x, 5.5, 1e-8, 'restored state must be written back to Planck');
  near(engine.physics.getNativeBody('snapshot-body').getLinearVelocity().x, 0.9, 1e-8, 'restored velocity must be written back to Planck');

  const lockedBuiltin = new AH2D.Engine({ physics: 'builtin' });
  lockedBuiltin.load({ engine: { physics: 'box2d' }, scene: [] });
  assert.strictEqual(lockedBuiltin.physics.name, 'builtin', 'an explicit constructor adapter must override project metadata');
  const lockedBox2D = new AH2D.Engine({ physics: 'box2d' });
  lockedBox2D.load({ engine: { physics: 'builtin' }, scene: [] });
  assert.strictEqual(lockedBox2D.physics.name, 'box2d', 'an explicit Box2D constructor choice must remain locked');

  const restoreBackend = new AH2D.Engine({ runtime: 'custom' });
  restoreBackend.load({ engine: { physics: 'builtin' }, scene: [{ id: 'authored-before-play' }] });
  const builtinSnapshot = restoreBackend.captureSnapshot();
  restoreBackend.load({ engine: { physics: 'box2d' }, scene: [{ id: 'runtime-replacement' }] });
  assert.strictEqual(restoreBackend.physics.name, 'box2d');
  delete builtinSnapshot.physicsAdapter;
  const observedRestoreAdapters = [];
  restoreBackend.events.on('document:load', () => observedRestoreAdapters.push(restoreBackend.physics.name));
  restoreBackend.restoreSnapshot(builtinSnapshot);
  assert.strictEqual(restoreBackend.physics.name, 'builtin', 'legacy snapshot restore must infer the adapter selected before Play from its document');
  assert.deepStrictEqual(observedRestoreAdapters, ['builtin'], 'snapshot restore must not expose a transient backend during document:load');
  assert.ok(restoreBackend.ecs.entities.has('authored-before-play'));
};

const testPublicPlayStopRestoresPhysicsBackendState = () => {
  const engine = new AH2D.Engine({ runtime: 'custom' });
  engine.load({
    engine: { physics: 'builtin', gravity: { x: 0, y: 0 }, pixelsPerMeter: 12 },
    scene: [
      { id: 'fixtureless-before-play', x: 11, y: 13, rigidbody: { type: 'dynamic', mass: 7, gravityScale: 0, velocityX: 3, velocityY: -2 } },
      { id: 'sensor-before-play', x: 21, y: 23, rigidbody: { type: 'dynamic', mass: 5, gravityScale: 0 }, collider: { id: 'play-sensor', shape: 'circle', radius: 4, isTrigger: true } }
    ]
  });
  engine.update(0);
  engine.start(null, { restoreOnStop: true });
  engine.load({ engine: { physics: 'box2d', pixelsPerMeter: 40 }, scene: [{ id: 'native-during-play' }] });
  engine.stop();
  assert.strictEqual(engine.physics.name, 'builtin');
  assert.strictEqual(engine.physics.pixelsPerMeter, 12);
  near(engine.physics.getBody('fixtureless-before-play').mass, 7, 1e-8);
  near(engine.physics.getBody('fixtureless-before-play').position.x, 11, 1e-8);
  near(engine.physics.getBody('fixtureless-before-play').velocity.x, 3, 1e-8);
  near(engine.physics.getBody('sensor-before-play').mass, 5, 1e-8);

  engine.load({
    engine: { physics: 'box2d', gravity: { x: 0, y: 0 }, pixelsPerMeter: 10 },
    scene: [{ id: 'native-before-play', x: 35, y: 45, rigidbody: { type: 'dynamic', mass: 6, gravityScale: 0, velocityX: 8, velocityY: -3 }, collider: { id: 'native-play-sensor', shape: 'circle', radius: 5, isTrigger: true } }]
  });
  engine.update(0);
  engine.start(null, { restoreOnStop: true });
  engine.load({ engine: { physics: 'builtin', pixelsPerMeter: 70 }, scene: [{ id: 'builtin-during-play' }] });
  engine.stop();
  assert.strictEqual(engine.physics.name, 'box2d');
  assert.strictEqual(engine.physics.usingNative, true);
  assert.strictEqual(engine.physics.pixelsPerMeter, 10);
  near(engine.physics.getBody('native-before-play').mass, 6, 1e-8);
  near(engine.physics.getNativeBody('native-before-play').getMass(), 6, 1e-8);
  near(engine.physics.getBody('native-before-play').position.x, 35, 1e-8);
  near(engine.physics.getBody('native-before-play').velocity.x, 8, 1e-8);
  near(engine.physics.getNativeBody('native-before-play').getPosition().x, 3.5, 1e-8);
};

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

const createFakePixi = ({ asyncInit = false, initDeferred = null, assetDeferred = null, assetLoader = null, assetCache = null } = {}) => {
  const applications = [], assetLoads = [];
  class Matrix {
    constructor(a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0) {
      Object.assign(this, { a, b, c, d, tx, ty });
    }
  }
  class Rectangle {
    constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height }); }
  }
  class Container {
    constructor() {
      this.children = [];
      this.parent = null;
      this.localMatrix = [1, 0, 0, 1, 0, 0];
      this.visible = true;
      this.alpha = 1;
      this.zIndex = 0;
    }
    addChild(child) {
      child.parent?.removeChild?.(child);
      this.children.push(child);
      child.parent = this;
      return child;
    }
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      if (child.parent === this) child.parent = null;
      return child;
    }
    getChildIndex(child) { return this.children.indexOf(child); }
    setChildIndex(child, index) {
      const current = this.children.indexOf(child);
      if (current < 0) return;
      this.children.splice(current, 1);
      this.children.splice(index, 0, child);
    }
    setFromMatrix(value) { this.localMatrix = [value.a, value.b, value.c, value.d, value.tx, value.ty]; }
    destroy(options = {}) {
      this.destroyed = true;
      if (options.children) [...this.children].forEach(child => child.destroy?.(options));
      [...this.children].forEach(child => this.removeChild(child));
    }
  }
  class Sprite {
    constructor(value) {
      this.texture = value?.texture || value;
      this.parent = null;
      this.anchor = { x: 0, y: 0, set: (x, y) => { this.anchor.x = x; this.anchor.y = y; } };
      this.alpha = 1;
      this.tint = 0xffffff;
    }
    destroy() { this.destroyed = true; }
  }
  class Graphics {
    constructor() { this.parent = null; this.commands = []; this.alpha = 1; }
    clear() { this.commands = []; return this; }
    rect(x, y, width, height) { this.pendingRect = { x, y, width, height }; return this; }
    fill(color) { this.commands.push({ ...this.pendingRect, color }); return this; }
    destroy() { this.destroyed = true; }
  }
  class MeshGeometry {
    constructor({ positions, uvs, indices } = {}) {
      this.positions = positions;
      this.uvs = uvs;
      this.indices = indices;
      this.destroyCount = 0;
    }
    destroy() { this.destroyed = true; this.destroyCount += 1; }
  }
  class Mesh {
    constructor(options = {}, legacyTexture = null) {
      if (options instanceof MeshGeometry) {
        this.geometry = options;
        this.texture = legacyTexture;
      } else {
        this.geometry = options.geometry;
        this.texture = options.texture;
      }
      this.parent = null;
      this.alpha = 1;
      this.tint = 0xffffff;
    }
    destroy() { this.destroyed = true; this.geometry?.destroy?.(); }
  }
  const setupApplication = (app, options = {}) => {
    app.stage = new Container();
    app.canvas = { nodeName: 'CANVAS', parentNode: null };
    const screen = { width: options.width || 800, height: options.height || 600 };
    app.renderer = {
      screen,
      background: {},
      resize(width, height) { screen.width = width; screen.height = height; }
    };
    app.screen = screen;
    app.ticker = { stopped: false, stop() { this.stopped = true; } };
    app.renderCount = 0;
    app.render = () => { app.renderCount += 1; };
    app.stop = () => { app.stopped = true; };
    app.destroy = () => { app.destroyed = true; app.destroyCount = (app.destroyCount || 0) + 1; };
  };
  let Application;
  if (asyncInit) {
    Application = class {
      constructor() { applications.push(this); }
      destroy() { this.destroyed = true; this.destroyCount = (this.destroyCount || 0) + 1; }
      init(options) {
        this.initOptions = options;
        const pending = initDeferred ? initDeferred.promise : Promise.resolve();
        return pending.then(() => { setupApplication(this, options); });
      }
    };
  } else {
    Application = class {
      constructor(options) { this.initOptions = options; setupApplication(this, options); applications.push(this); }
    };
  }
  class Texture {
    constructor(options = {}) {
      if (options && options.source) Object.assign(this, options);
      else this.source = options;
    }
    destroy() { this.destroyed = true; }
    static from(source) { return new Texture({ source: { id: String(source) }, id: String(source) }); }
  }
  Texture.WHITE = new Texture({ source: { id: 'white' }, id: 'white' });
  const Assets = {
    get(key) { return assetCache?.get(key) || null; },
    load(source) {
      assetLoads.push(source);
      if (assetLoader) return assetLoader(source);
      return assetDeferred ? assetDeferred.promise : Promise.resolve({ id: String(source) });
    }
  };
  return { Application, Container, Sprite, Graphics, Mesh, MeshGeometry, Matrix, Rectangle, Texture, Assets, applications, assetLoads };
};

const fakeHost = (width = 960, height = 600) => ({
  clientWidth: width,
  clientHeight: height,
  children: [],
  appendChild(child) {
    child.parentNode?.removeChild?.(child);
    this.children.push(child);
    child.parentNode = this;
  },
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parentNode === this) child.parentNode = null;
  }
});

const testPixiV8AsyncMountAndNativeScene = async () => {
  const initDeferred = deferred();
  const PIXI = createFakePixi({ asyncInit: true, initDeferred });
  const host = fakeHost(640, 360);
  const engine = new AH2D.Engine({
    physics: 'builtin',
    runtime: 'pixijs',
    runtimeOptions: { PIXI, applicationOptions: { autoStart: true } }
  });
  engine.load({
    format: 'AH2D',
    version: 4,
    assets: [{ id: 'hero-image', imageSrc: '/textures/hero.png' }],
    scene: [
      {
        id: 'native-parent',
        components: {
          Transform: { x: 20, y: 30, rotation: 30, scaleX: 2, scaleY: 3 },
          Renderable: { width: 80, height: 40, color: '#336699', layer: 2 }
        }
      },
      {
        id: 'native-child',
        parentId: 'native-parent',
        components: {
          Transform: { x: 7, y: -4, rotation: -15, scaleX: 0.5, scaleY: 1.25 },
          Renderable: { assetId: 'hero-image', width: 32, height: 18, anchorX: 0.25, anchorY: 0.75, layer: 5 }
        }
      }
    ]
  });

  const readyEvents = [];
  engine.events.on('runtime:ready', event => readyEvents.push(event));
  engine.start(host, { restoreOnStop: false });
  const runtime = engine.runtime;
  const app = PIXI.applications[0];
  const ready = runtime.ready;

  assert.ok(app, 'Pixi v8 Application must be constructed before asynchronous init');
  assert.strictEqual(app.initOptions.autoStart, false, 'Pixi must not run a second ticker-driven game loop');
  assert.strictEqual(app.initOptions.resizeTo, host, 'a host element must be supplied as the Pixi resize target');
  assert.strictEqual(app.initOptions.width, 640);
  assert.strictEqual(app.initOptions.height, 360);
  assert.strictEqual(host.children.length, 0, 'the canvas must not mount until Application.init resolves');
  assert.strictEqual(runtime.world, null);

  initDeferred.resolve();
  await ready;
  await flushPromises();

  assert.strictEqual(runtime.backend, 'pixijs');
  assert.strictEqual(runtime.native, true);
  assert.ok(runtime.world instanceof PIXI.Container, 'the native world must be a real PIXI.Container');
  assert.strictEqual(app.stage.children[0], runtime.world);
  assert.strictEqual(host.children[0], app.canvas, 'the v8 canvas must mount in the supplied host');
  assert.strictEqual(app.stopped, true, 'Application ticker must remain stopped');
  assert.strictEqual(app.ticker.stopped, true, 'the native ticker must remain stopped');
  assert.strictEqual(readyEvents.length, 1);

  const parent = runtime.nodes.get('native-parent');
  const child = runtime.nodes.get('native-child');
  assert.ok(parent.node instanceof PIXI.Container);
  assert.ok(parent.visualHost instanceof PIXI.Container);
  assert.ok(parent.childrenHost instanceof PIXI.Container);
  assert.ok(parent.visual instanceof PIXI.Graphics, 'an untextured Renderable must use PIXI.Graphics');
  assert.ok(child.visual instanceof PIXI.Sprite, 'a textured Renderable must use PIXI.Sprite');
  assert.strictEqual(parent.node.parent, runtime.world);
  assert.strictEqual(child.node.parent, parent.childrenHost, 'native nesting must mirror the AH2D Scene Graph');
  matrixNear(parent.node.localMatrix, AH2D.Matrix2D.compose(20, 30, 30, 2, 3), 1e-8, 'Pixi parent local matrix');
  matrixNear(child.node.localMatrix, AH2D.Matrix2D.compose(7, -4, -15, 0.5, 1.25), 1e-8, 'Pixi child local matrix');
  assert.deepStrictEqual(parent.visual.commands, [{ x: -40, y: -20, width: 80, height: 40, color: 0x336699 }]);
  assert.strictEqual(parent.node.zIndex, 2);
  assert.strictEqual(child.node.zIndex, 5);
  assert.strictEqual(child.visual.anchor.x, 0.25);
  assert.strictEqual(child.visual.anchor.y, 0.75);
  assert.deepStrictEqual(PIXI.assetLoads, ['/textures/hero.png']);
  assert.deepStrictEqual(child.visual.texture, { id: '/textures/hero.png' });

  engine.stop({ restore: false });
  assert.strictEqual(app.destroyed, true);
  assert.deepStrictEqual(host.children, [], 'stopping must remove an adapter-owned canvas');
};

const testPixiRuntimeMutationsAndAssetStaleness = async () => {
  const slowA = deferred(), slowB = deferred(), slowC = deferred();
  const pending = new Map([
    ['/slow-a.png', slowA],
    ['/slow-b.png', slowB],
    ['/slow-c.png', slowC]
  ]);
  const PIXI = createFakePixi({ assetLoader: source => pending.get(source)?.promise || Promise.resolve({ id: source }) });
  const host = fakeHost();
  const engine = new AH2D.Engine({ runtime: 'pixijs', runtimeOptions: { PIXI }, physics: 'builtin' });
  engine.load({ scene: [
    { id: 'parent-a', x: 10, y: 0 },
    { id: 'parent-b', x: 100, y: 0 },
    {
      id: 'mutable-sprite',
      parentId: 'parent-a',
      components: {
        Transform: { x: 3, y: 4 },
        Renderable: { imageSrc: '/slow-a.png', width: 20, height: 10, layer: 1 }
      }
    },
    {
      id: 'dedupe-sprite',
      parentId: 'parent-b',
      components: { Renderable: { imageSrc: '/slow-a.png', width: 6, height: 6 } }
    }
  ] });
  engine.start(host, { restoreOnStop: false });
  const runtime = engine.runtime;
  const record = runtime.nodes.get('mutable-sprite');
  const dedupeRecord = runtime.nodes.get('dedupe-sprite');
  const sprite = record.visual;
  assert.ok(sprite instanceof PIXI.Sprite);
  assert.strictEqual(sprite.texture, PIXI.Texture.WHITE, 'pending textures must use a deterministic placeholder');

  runtime.render();
  runtime.render();
  assert.deepStrictEqual(
    PIXI.assetLoads,
    ['/slow-a.png'],
    'unchanged sources and a second Entity sharing that source must deduplicate Assets.load'
  );

  const renderable = engine.ecs.get('mutable-sprite', 'Renderable');
  renderable.imageSrc = '/slow-b.png';
  renderable.layer = 12;
  engine.ecs.add('mutable-sprite', 'Hidden', {});
  runtime.render();
  assert.deepStrictEqual(PIXI.assetLoads, ['/slow-a.png', '/slow-b.png']);
  assert.strictEqual(record.node.zIndex, 12, 'layer edits must synchronize to native zIndex');
  assert.strictEqual(record.node.visible, false, 'Hidden must hide the complete native Entity node');

  slowB.resolve({ id: 'texture-b' });
  await flushPromises();
  assert.deepStrictEqual(sprite.texture, { id: 'texture-b' });
  slowA.resolve({ id: 'stale-texture-a' });
  await flushPromises();
  assert.deepStrictEqual(sprite.texture, { id: 'texture-b' }, 'a stale asset completion must not replace the current source');
  assert.deepStrictEqual(dedupeRecord.visual.texture, { id: 'stale-texture-a' }, 'the shared load must still update an Entity whose source is current');

  engine.ecs.remove('mutable-sprite', 'Hidden');
  engine.reparent('mutable-sprite', 'parent-b');
  runtime.render();
  assert.strictEqual(record.node.visible, true);
  assert.strictEqual(record.node.parent, runtime.nodes.get('parent-b').childrenHost, 'runtime reparenting must update native ownership');
  matrixNear(record.node.localMatrix, AH2D.Matrix2D.compose(3, 4, 0, 1, 1), 1e-8, 'reparented Pixi local matrix');

  engine.createEntity({
    id: 'created-shape',
    x: -8,
    y: 6,
    components: { Renderable: { width: 14, height: 12, color: '#abc', layer: -1 } }
  });
  runtime.render();
  const created = runtime.nodes.get('created-shape');
  assert.ok(created.visual instanceof PIXI.Graphics, 'new ECS Renderables must create native visuals on the next render');
  assert.deepStrictEqual(created.visual.commands, [{ x: -7, y: -6, width: 14, height: 12, color: 0xaabbcc }]);
  engine.destroyEntity('created-shape');
  runtime.render();
  assert.strictEqual(runtime.nodes.has('created-shape'), false);
  assert.strictEqual(created.node.destroyed, true, 'deleted ECS Entities must destroy their native node');

  renderable.imageSrc = null;
  runtime.render();
  assert.ok(record.visual instanceof PIXI.Graphics, 'removing a texture source must replace the Sprite with Graphics');
  assert.strictEqual(sprite.destroyed, true, 'source-kind changes must clean up the obsolete visual');

  renderable.imageSrc = '/slow-c.png';
  runtime.render();
  const pendingSprite = record.visual;
  assert.ok(pendingSprite instanceof PIXI.Sprite);
  assert.strictEqual(pendingSprite.texture, PIXI.Texture.WHITE);
  engine.stop({ restore: false });
  assert.strictEqual(pendingSprite.destroyed, true);
  slowC.resolve({ id: 'late-after-stop' });
  await flushPromises();
  assert.strictEqual(pendingSprite.texture, PIXI.Texture.WHITE, 'asset completion after stop must not mutate a destroyed Sprite');
  assert.strictEqual(runtime.nodes.size, 0);
  assert.strictEqual(runtime.textureLoads.size, 0, 'unmount must release the adapter pending-load registry');
  assert.deepStrictEqual(host.children, []);
};

const testPixiSourceRectSubtextures = () => {
  const PIXI = createFakePixi();
  const baseTexture = PIXI.Texture.from('/sprites/actor.png');
  const engine = new AH2D.Engine({
    runtime: 'pixijs', physics: 'builtin',
    runtimeOptions: { PIXI, loadAssets: false, textureResolver: () => baseTexture }
  });
  engine.load({ scene: [{ id: 'animated-sprite', components: { Renderable: {
    imageSrc: '/sprites/actor.png', sourceRect: { x: 0, y: 16, width: 32, height: 24 }
  } } }] });
  engine.start(fakeHost(), { restoreOnStop: false });
  const runtime = engine.runtime;
  const record = runtime.nodes.get('animated-sprite');
  const firstTexture = record.visual.texture;
  const firstKey = record.sourceKey;
  assert.notStrictEqual(firstTexture, baseTexture);
  assert.ok(firstTexture.frame instanceof PIXI.Rectangle);
  assert.deepStrictEqual(
    { x: firstTexture.frame.x, y: firstTexture.frame.y, width: firstTexture.frame.width, height: firstTexture.frame.height },
    { x: 0, y: 16, width: 32, height: 24 }
  );
  assert.strictEqual(record.visual.width, 32);
  assert.strictEqual(record.visual.height, 24);

  engine.ecs.get('animated-sprite', 'Renderable').sourceRect.x = 32;
  runtime.render();
  const secondTexture = record.visual.texture;
  assert.notStrictEqual(record.sourceKey, firstKey, 'sourceRect participates in the native texture cache key');
  assert.notStrictEqual(secondTexture, firstTexture);
  assert.strictEqual(firstTexture.destroyed, true, 'replaced adapter-owned subtextures are released');
  assert.strictEqual(secondTexture.frame.x, 32);

  delete engine.ecs.get('animated-sprite', 'Renderable').sourceRect;
  runtime.render();
  assert.strictEqual(record.visual.texture, baseTexture);
  assert.strictEqual(secondTexture.destroyed, true);
  engine.stop({ restore: false });
};

const testPixiLiveChildrenSurviveParentDeletion = () => {
  const PIXI = createFakePixi();
  const engine = new AH2D.Engine({ runtime: 'pixijs', runtimeOptions: { PIXI }, physics: 'builtin' });
  engine.load({ scene: [
    { id: 'grandparent' },
    { id: 'reparent-parent', parentId: 'grandparent' },
    { id: 'reparent-child', parentId: 'reparent-parent', components: { Renderable: { width: 8, height: 6, color: '#123456' } } },
    { id: 'detach-parent' },
    { id: 'detach-child', parentId: 'detach-parent', components: { Renderable: { width: 9, height: 7, color: '#654321' } } }
  ] });
  engine.start(fakeHost(), { restoreOnStop: false });
  const runtime = engine.runtime;
  const reparentChild = runtime.nodes.get('reparent-child');
  const detachChild = runtime.nodes.get('detach-child');

  engine.destroyEntity('reparent-parent', { childPolicy: 'reparent' });
  runtime.render();
  assert.strictEqual(reparentChild.node.parent, runtime.nodes.get('grandparent').childrenHost);
  assert.notStrictEqual(reparentChild.node.destroyed, true, 'a live child node must survive native parent deletion with childPolicy=reparent');
  assert.notStrictEqual(reparentChild.visual.destroyed, true, 'a live child visual must survive native parent deletion with childPolicy=reparent');

  engine.destroyEntity('detach-parent', { childPolicy: 'detach' });
  runtime.render();
  assert.strictEqual(detachChild.node.parent, runtime.world);
  assert.notStrictEqual(detachChild.node.destroyed, true, 'a live child node must survive native parent deletion with childPolicy=detach');
  assert.notStrictEqual(detachChild.visual.destroyed, true, 'a live child visual must survive native parent deletion with childPolicy=detach');
  engine.stop({ restore: false });
};

const testPixiStopWhileInitializationPending = async () => {
  const initDeferred = deferred();
  const PIXI = createFakePixi({ asyncInit: true, initDeferred });
  const host = fakeHost();
  const engine = new AH2D.Engine({ runtime: 'pixijs', runtimeOptions: { PIXI }, physics: 'builtin' });
  engine.load({ scene: [{ id: 'pending-init-shape', components: { Renderable: { width: 10, height: 10 } } }] });
  engine.start(host, { restoreOnStop: false });
  const runtime = engine.runtime;
  const app = PIXI.applications[0];
  const pendingReady = runtime.ready;
  engine.stop({ restore: false });
  assert.strictEqual(engine.running, false);
  assert.strictEqual(app.destroyed, true, 'stop must dispose an Application whose init is pending');
  assert.strictEqual(runtime.app, null);

  initDeferred.resolve();
  await pendingReady;
  await flushPromises();
  assert.strictEqual(app.destroyCount, 2, 'a stale init completion must dispose the now-initialized Application as well');
  assert.strictEqual(runtime.app, null, 'stale Application.init completion must not remount after stop');
  assert.strictEqual(runtime.world, null);
  assert.strictEqual(runtime.nodes.size, 0);
  assert.strictEqual(host.children.length, 0, 'stale init completion must not append a canvas');
};

const testMultiScenePlaySnapshotRestoreWithPixi = async () => {
  const PIXI = createFakePixi();
  const host = fakeHost();
  const engine = new AH2D.Engine({ runtime: 'pixijs', runtimeOptions: { PIXI }, physics: 'builtin' });
  engine.load({
    format: 'AH2D',
    version: 4,
    currentSceneId: 'edit-scene',
    customProjectData: { keep: true },
    scenes: [
      { id: 'edit-scene', name: 'Edit Scene', objects: [{ id: 'edit-object', x: 11, components: { Renderable: { width: 10, height: 10 } } }] },
      { id: 'battle-scene', name: 'Battle Scene', customSceneData: { keep: true }, objects: [{ id: 'battle-object', x: 200, components: { Renderable: { width: 20, height: 20 } } }] }
    ],
    scene: [{ id: 'stale-mirror' }]
  });
  engine.start(host, { restoreOnStop: true });
  const runtime = engine.runtime;
  assert.ok(runtime.nodes.has('edit-object'));

  engine.ecs.get('edit-object', 'Transform').x = 99;
  engine.loadScene('battle-scene');
  engine.createEntity({ id: 'play-only', x: 300, components: { Renderable: { width: 5, height: 5 } } });
  engine.document.customProjectData.keep = false;
  engine.document.scenes[1].customSceneData.keep = false;
  runtime.render();
  assert.ok(runtime.nodes.has('battle-object'));
  assert.ok(runtime.nodes.has('play-only'));
  assert.ok(!runtime.nodes.has('edit-object'));

  engine.stop();
  assert.strictEqual(engine.running, false);
  assert.strictEqual(engine.activeSceneId, 'edit-scene', 'Stop must restore the Scene that was active before Play');
  assert.strictEqual(engine.document.currentSceneId, 'edit-scene');
  assert.deepStrictEqual(engine.document.scene, engine.document.scenes[0].objects, 'the restored compatibility mirror must match the restored active Scene');
  assert.strictEqual(engine.document.customProjectData.keep, true, 'unknown project fields must survive Play snapshot restoration');
  assert.strictEqual(engine.document.scenes[1].customSceneData.keep, true, 'inactive Scene data must survive Play snapshot restoration');
  assert.deepStrictEqual(engine.document.scenes.map(scene => scene.id), ['edit-scene', 'battle-scene']);
  assert.ok(engine.ecs.entities.has('edit-object'));
  assert.ok(!engine.ecs.entities.has('battle-object'));
  assert.ok(!engine.ecs.entities.has('play-only'));
  assert.strictEqual(engine.ecs.get('edit-object', 'Transform').x, 11);
  assert.strictEqual(runtime.nodes.size, 0, 'restoration followed by stop must leave the native runtime unmounted');
  assert.deepStrictEqual(host.children, []);

  engine.start(host, { restoreOnStop: false });
  await runtime.ready;
  assert.ok(runtime.nodes.has('edit-object'), 'the restored active Scene must remount on the next Play');
  assert.ok(!runtime.nodes.has('battle-object'));
  engine.stop({ restore: false });
};

const testFrameErrorStopsPixiRuntime = () => {
  const PIXI = createFakePixi();
  const host = fakeHost();
  const engine = new AH2D.Engine({ runtime: 'pixijs', runtimeOptions: { PIXI }, physics: 'builtin' });
  engine.load({ scene: [{ id: 'frame-error-shape', components: { Renderable: { width: 10, height: 10 } } }] });
  const errors = [];
  engine.events.on('runtime:error', event => errors.push(event));
  engine.start(host, { restoreOnStop: false });
  const runtime = engine.runtime;
  const app = runtime.app;
  const expected = new Error('fake Pixi render failure');
  app.render = () => { throw expected; };

  engine.frame(engine.lastTime + 16);
  assert.strictEqual(engine.running, false, 'a frame failure must transition the Engine out of running state');
  assert.strictEqual(engine.frameHandle, null, 'a failed frame must not remain scheduled');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].error, expected);
  assert.strictEqual(app.destroyed, true, 'a failed Pixi frame must unmount the native Application');
  assert.strictEqual(runtime.app, null);
  assert.deepStrictEqual(host.children, []);
};

const testPrefabAssetInstanceOverrideApplyRevertAndUnpack = () => {
  const sourceObjects = [
    { id: 'holder', name: 'Holder', x: 5, y: 6 },
    { id: 'source-root', name: 'Crate', parentId: 'holder', x: 120, y: 80, rot: 15, sx: 2, sy: 2, futureScene: { keep: true } },
    { id: 'source-child', name: 'Gem', parentId: 'source-root', x: 12, y: 4, values: ['a', 'b'], shiftValues: ['a', 'b', 'c'], futureBranch: { a: 1, b: 2 }, components: {
      Renderable: { kind: 'sprite', width: 16, height: 16, color: '#00aaff', futureRender: { keep: true } }
    } },
    { id: 'source-grandchild', name: 'Spark', parentId: 'source-child', x: 3, y: 2 }
  ];
  const project = {
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    engine: { physics: 'builtin' },
    currentSceneId: 'main', meta: { currentSceneId: 'main' },
    prefabs: [],
    scenes: [{ id: 'main', name: 'Main', objects: sourceObjects }, { id: 'secondary', name: 'Secondary', objects: [] }],
    scene: JSON.parse(JSON.stringify(sourceObjects)),
    futureProject: { keep: true }
  };
  const engine = new AH2D.Engine({ physics: 'builtin' });
  const events = [];
  for (const type of ['prefab:assetCreate', 'prefab:instantiate', 'prefab:override', 'prefab:apply', 'prefab:revert', 'prefab:unpack', 'prefab:assetDelete']) {
    engine.events.on(type, payload => events.push({ type, payload }));
  }
  engine.load(project);
  assert.ok(engine.prefabs instanceof AH2D.PrefabSystem);

  const asset = engine.prefabs.createAsset('source-root', {
    id: 'crate', name: 'Crate', extensions: { futureAsset: { keep: true } }
  });
  assert.strictEqual(asset.id, 'crate');
  assert.strictEqual(asset.rootEntityId, 'source-root');
  assert.strictEqual(asset.revision, 1);
  assert.deepStrictEqual(asset.futureAsset, { keep: true });
  const assetRoot = asset.entities.find(entity => entity.id === 'source-root');
  assert.deepStrictEqual(
    { x: assetRoot.x, y: assetRoot.y, rot: assetRoot.rot, sx: assetRoot.sx, sy: assetRoot.sy },
    { x: 0, y: 0, rot: 0, sx: 1, sy: 1 },
    'a newly-authored Prefab root Transform must be normalized while the linked instance keeps placement'
  );
  let scene = engine.document.scenes[0];
  let firstRoot = scene.objects.find(entity => entity.id === 'source-root');
  let firstChild = scene.objects.find(entity => entity.id === 'source-child');
  assert.deepStrictEqual({ x: firstRoot.x, y: firstRoot.y, rot: firstRoot.rot, sx: firstRoot.sx, sy: firstRoot.sy }, { x: 120, y: 80, rot: 15, sx: 2, sy: 2 });
  assert.deepStrictEqual(firstRoot.futureScene, { keep: true });
  assert.deepStrictEqual(firstRoot.components.PrefabInstance, {
    prefabId: 'crate', sourceEntityId: 'source-root', instanceRootId: 'source-root', prefabRevision: 1, overrides: {}
  });
  assert.strictEqual(firstChild.components.PrefabInstance.sourceEntityId, 'source-child');
  assert.deepStrictEqual(engine.document.scene, scene.objects, 'Prefab mutations must keep the active Scene mirror synchronized');
  assert.throws(
    () => engine.prefabs.createAsset('holder', { id: 'nested' }),
    error => error.code === 'E_PREFAB_NESTED_INSTANCE',
    'a subtree containing a connected Prefab instance must be unpacked before it can become an Asset'
  );

  engine.loadScene('secondary');
  engine.prefabs.instantiate('crate', {
    idMap: { 'source-root': 'source-root', 'source-child': 'source-child', 'source-grandchild': 'source-grandchild' }
  });
  engine.loadScene('main');

  const created = engine.prefabs.instantiate('crate', {
    parentId: 'holder',
    idMap: { 'source-root': 'crate-2', 'source-child': 'gem-2', 'source-grandchild': 'spark-2' },
    transform: { x: 300, y: 220, rotation: 30, scaleX: 1.5, scaleY: 1.5 }
  });
  assert.deepStrictEqual(created.idMap, { 'source-root': 'crate-2', 'source-child': 'gem-2', 'source-grandchild': 'spark-2' });
  assert.strictEqual(engine.graph.getParent('crate-2'), 'holder');
  assert.strictEqual(engine.graph.getParent('gem-2'), 'crate-2');
  assert.strictEqual(engine.graph.getParent('spark-2'), 'gem-2');
  assert.throws(
    () => engine.prefabs.instantiate('crate', { parentId: 'source-child' }),
    error => error.code === 'E_PREFAB_STRUCTURAL_EDIT',
    'instantiation must not add a structural child below a connected Prefab member'
  );
  assert.deepStrictEqual(
    (({ x, y, rotation, scaleX, scaleY }) => ({ x, y, rotation, scaleX, scaleY }))(engine.transform.getLocal('crate-2')),
    { x: 300, y: 220, rotation: 30, scaleX: 1.5, scaleY: 1.5 }
  );
  const instance = engine.prefabs.getInstance('gem-2');
  assert.strictEqual(instance.instanceRootId, 'crate-2');
  assert.deepStrictEqual(instance.members.map(member => member.sourceEntityId).sort(), ['source-child', 'source-grandchild', 'source-root']);
  assert.throws(() => engine.prefabs.setOverride('crate-2', '/x', 1), error => error.code === 'E_PREFAB_PLACEMENT_PATH');
  assert.throws(() => engine.prefabs.setOverride('gem-2', '/parentId', 'holder'), error => error.code === 'E_PREFAB_OVERRIDE_PROTECTED');

  engine.prefabs.removeOverride('gem-2', '/values/0');
  assert.deepStrictEqual(engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2').values, ['b']);
  engine.prefabs.revert('gem-2', '/values/0');
  assert.deepStrictEqual(engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2').values, ['a', 'b'], 'reverting an array removal must reinsert instead of replacing the shifted element');
  engine.prefabs.removeOverride('source-child', '/values/0');
  engine.prefabs.apply('source-child', { paths: '/values/0' });
  assert.deepStrictEqual(engine.prefabs.get('crate').entities.find(entity => entity.id === 'source-child').values, ['b']);
  assert.deepStrictEqual(engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2').values, ['b'], 'applying an array removal must remove from unoverridden instances');
  assert.deepStrictEqual(
    engine.document.scenes[1].objects.find(entity => entity.id === 'source-child').values,
    ['b'],
    'Apply must synchronize a same-ID instance member in another Scene instead of mistaking it for the authoring member'
  );

  engine.prefabs.setOverride('source-child', '/components/Renderable/color', '#ff0000');
  engine.prefabs.setOverride('gem-2', '/components/Renderable/color', '#00ff00');
  let applyResult = engine.prefabs.apply('source-child', { paths: ['/components/Renderable/color'] });
  assert.strictEqual(applyResult.revision, 3);
  assert.strictEqual(engine.prefabs.get('crate').entities.find(entity => entity.id === 'source-child').components.Renderable.color, '#ff0000');
  scene = engine.document.scenes[0];
  firstChild = scene.objects.find(entity => entity.id === 'source-child');
  let secondChild = scene.objects.find(entity => entity.id === 'gem-2');
  assert.strictEqual(firstChild.components.Renderable.color, '#ff0000');
  assert.strictEqual(secondChild.components.Renderable.color, '#00ff00', 'another instance with its own override must not be overwritten by Apply');
  assert.strictEqual(firstChild.components.PrefabInstance.prefabRevision, 3);
  assert.strictEqual(secondChild.components.PrefabInstance.prefabRevision, 3);

  engine.prefabs.setOverride('source-child', '/components/Renderable', {
    ...firstChild.components.Renderable,
    width: 32,
    color: '#aa0000'
  });
  engine.prefabs.apply('source-child', { paths: '/components/Renderable' });
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  assert.strictEqual(secondChild.components.Renderable.width, 32, 'unoverridden descendants must sync when an Asset ancestor object changes');
  assert.strictEqual(secondChild.components.Renderable.color, '#00ff00', 'a descendant override must survive an Asset ancestor object change');
  assert.strictEqual(secondChild.components.PrefabInstance.overrides['/components/Renderable/color'].op, 'replace');

  engine.prefabs.revert('gem-2', '/components/Renderable/color');
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  assert.strictEqual(secondChild.components.Renderable.color, '#aa0000');
  assert.deepStrictEqual(secondChild.components.PrefabInstance.overrides, {});

  engine.prefabs.setOverride('gem-2', '/components/Renderable', {
    ...secondChild.components.Renderable,
    width: 48,
    height: 24,
    color: '#123456'
  });
  engine.prefabs.setOverride('gem-2', '/components/Renderable/color', '#654321');
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  let nestedOverrides = secondChild.components.PrefabInstance.overrides;
  assert.deepStrictEqual(Object.keys(nestedOverrides), ['/components/Renderable'], 'a descendant edit must stay represented by its owning ancestor override');
  assert.strictEqual(nestedOverrides['/components/Renderable'].value.width, 48, 'rebasing a descendant edit must preserve an overridden sibling');
  assert.strictEqual(nestedOverrides['/components/Renderable'].value.color, '#654321');
  engine.prefabs.removeOverride('gem-2', '/components/Renderable/height');
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  nestedOverrides = secondChild.components.PrefabInstance.overrides;
  assert.deepStrictEqual(Object.keys(nestedOverrides), ['/components/Renderable']);
  assert.strictEqual(nestedOverrides['/components/Renderable'].value.width, 48, 'nested removal must not discard sibling state owned by the ancestor');
  assert.strictEqual(nestedOverrides['/components/Renderable'].value.color, '#654321');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(nestedOverrides['/components/Renderable'].value, 'height'), false);
  engine.prefabs.revert('gem-2', '/components/Renderable');

  engine.prefabs.setOverride('gem-2', '/localBundle', { first: 1, second: 2 });
  engine.prefabs.removeOverride('gem-2', '/localBundle/first');
  engine.prefabs.setOverride('gem-2', '/localBundle/third', 3);
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  nestedOverrides = secondChild.components.PrefabInstance.overrides;
  assert.deepStrictEqual(Object.keys(nestedOverrides), ['/localBundle'], 'nested edits of an Asset-relative add must remain one non-overlapping add record');
  assert.deepStrictEqual(nestedOverrides['/localBundle'], { op: 'add', value: { second: 2, third: 3 } });
  engine.prefabs.revert('gem-2', '/localBundle');

  engine.prefabs.setOverride('gem-2', '/futureAdded', { pass: 1 });
  engine.prefabs.setOverride('gem-2', '/futureAdded', { pass: 2 });
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  assert.strictEqual(secondChild.components.PrefabInstance.overrides['/futureAdded'].op, 'add', 'replacing a locally-added value must remain an Asset-relative add');
  engine.prefabs.apply('gem-2', { paths: '/futureAdded' });
  assert.deepStrictEqual(engine.prefabs.get('crate').entities.find(entity => entity.id === 'source-child').futureAdded, { pass: 2 });

  engine.prefabs.removeOverride('gem-2', '/futureAdded');
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  assert.strictEqual(secondChild.futureAdded, undefined);
  assert.strictEqual(secondChild.components.PrefabInstance.overrides['/futureAdded'].op, 'remove');
  engine.prefabs.apply('gem-2', { paths: '/futureAdded' });
  assert.strictEqual(engine.prefabs.get('crate').entities.find(entity => entity.id === 'source-child').futureAdded, undefined);

  engine.prefabs.setOverride('gem-2', '/temporary', 1);
  engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2').components.PrefabInstance.overrides['/temporary'].futureRecord = { keep: true };
  engine.prefabs.setOverride('gem-2', '/temporary', 2);
  assert.deepStrictEqual(
    engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2').components.PrefabInstance.overrides['/temporary'].futureRecord,
    { keep: true },
    'editing the same override path must preserve unknown operation fields'
  );
  const cleared = engine.prefabs.removeOverride('gem-2', '/temporary');
  assert.strictEqual(cleared.reverted, true, 'removing an add whose source is absent must clear the override instead of recording an invalid remove');
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  assert.strictEqual(secondChild.temporary, undefined);
  assert.strictEqual(secondChild.components.PrefabInstance.overrides['/temporary'], undefined);

  engine.prefabs.setOverride('spark-2', '/components/Health', { current: 5, max: 5 });
  engine.prefabs.apply('spark-2', { paths: '/components/Health' });
  assert.deepStrictEqual(engine.prefabs.get('crate').entities.find(entity => entity.id === 'source-grandchild').components.Health, { current: 5, max: 5 }, 'a whole Component may be added to a compact Asset Entity');

  engine.prefabs.setOverride('gem-2', '/futureBranch/a', 9);
  engine.prefabs.removeOverride('source-child', '/futureBranch');
  engine.prefabs.apply('source-child', { paths: '/futureBranch' });
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  assert.deepStrictEqual(secondChild.futureBranch, { a: 9, b: 2 }, 'an orphaned descendant override must preserve its effective branch');
  assert.deepStrictEqual(secondChild.components.PrefabInstance.overrides['/futureBranch'], {
    op: 'add', value: { a: 9, b: 2 }
  }, 'an orphaned descendant override must be promoted to a valid ancestor add');
  engine.prefabs.revert('gem-2', '/futureBranch');

  engine.prefabs.setOverride('gem-2', '/shiftValues/2', 'X');
  engine.prefabs.removeOverride('source-child', '/shiftValues/0');
  engine.prefabs.apply('source-child', { paths: '/shiftValues/0' });
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  assert.deepStrictEqual(secondChild.shiftValues, ['b', 'X'], 'an array removal must preserve a later overridden element');
  assert.strictEqual(secondChild.components.PrefabInstance.overrides['/shiftValues/2'], undefined);
  assert.deepStrictEqual(secondChild.components.PrefabInstance.overrides['/shiftValues/1'], { op: 'replace', value: 'X' });
  engine.prefabs.revert('gem-2', '/shiftValues/1');

  engine.prefabs.setOverride('gem-2', '/shiftValues/0', 'Local B');
  engine.prefabs.removeOverride('source-child', '/shiftValues/0');
  engine.prefabs.apply('source-child', { paths: '/shiftValues/0' });
  secondChild = engine.document.scenes[0].objects.find(entity => entity.id === 'gem-2');
  assert.deepStrictEqual(secondChild.shiftValues, ['Local B', 'c'], 'an override of a removed array element must retain a reconstructable effective array');
  assert.deepStrictEqual(secondChild.components.PrefabInstance.overrides['/shiftValues'], {
    op: 'replace', value: ['Local B', 'c']
  });
  engine.prefabs.revert('gem-2', '/shiftValues');

  const unpacked = engine.prefabs.unpack('gem-2');
  assert.deepStrictEqual(unpacked.entityIds.sort(), ['crate-2', 'gem-2', 'spark-2']);
  scene = engine.document.scenes[0];
  assert.strictEqual(scene.objects.find(entity => entity.id === 'crate-2').components.PrefabInstance, undefined);
  assert.strictEqual(scene.objects.find(entity => entity.id === 'gem-2').components.PrefabInstance, undefined);
  assert.strictEqual(scene.objects.find(entity => entity.id === 'spark-2').components.PrefabInstance, undefined);
  assert.strictEqual(engine.graph.getParent('gem-2'), 'crate-2', 'Unpack must preserve hierarchy');
  assert.deepStrictEqual(
    (({ x, y, rotation, scaleX, scaleY }) => ({ x, y, rotation, scaleX, scaleY }))(engine.transform.getLocal('crate-2')),
    { x: 300, y: 220, rotation: 30, scaleX: 1.5, scaleY: 1.5 },
    'Unpack must preserve placement'
  );

  assert.throws(() => engine.prefabs.deleteAsset('crate'), error => error.code === 'E_PREFAB_ASSET_IN_USE');
  assert.strictEqual(engine.prefabs.deleteAsset('crate', { unpackInstances: true }), true);
  assert.strictEqual(engine.prefabs.get('crate'), null);
  assert.strictEqual(engine.document.scenes[0].objects.find(entity => entity.id === 'source-root').components.PrefabInstance, undefined);
  assert.strictEqual(engine.document.scenes[1].objects.find(entity => entity.id === 'source-root').components.PrefabInstance, undefined);
  assert.deepStrictEqual(engine.document.futureProject, { keep: true });
  const eventTypes = events.map(event => event.type);
  for (const type of ['prefab:assetCreate', 'prefab:instantiate', 'prefab:override', 'prefab:apply', 'prefab:revert', 'prefab:unpack', 'prefab:assetDelete']) {
    assert(eventTypes.includes(type), `${type} must be emitted`);
  }
  assert(events.every(event => event.payload.engine === engine), 'Prefab events must identify their Engine');
};

const testSkeletalPrefabUnpackRemapsRigAndAnimationReferences = () => {
  const rigEntities = () => [
    { id: 'rig', components: { Skeleton: { rootBoneId: 'hip', futureSkeleton: { keep: true } }, Animation: { clipId: 'pose', futureBinding: true } } },
    { id: 'hip', parentId: 'rig', components: { Bone: { length: 40 } } },
    { id: 'knee', parentId: 'hip', components: { Bone: { length: 30 } } },
    { id: 'target', parentId: 'rig', components: { IK: { skeletonRootId: 'rig', bones: ['hip', 'knee'], mix: 1, iterations: 8, tolerance: 0.01, bendDirection: 1 } } },
    { id: 'mesh', parentId: 'rig', components: { Skin: {
      skeletonRootId: 'rig',
      vertices: [{ x: 0, y: 0, weights: [{ boneId: 'hip', weight: 0.25 }, { boneId: 'knee', weight: 0.75 }] }],
      uvs: [0, 0], indices: [0, 0, 0], futureSkin: { keep: true }
    } } }
  ];
  const clips = () => [
    {
      id: 'pose', name: 'Pose', fps: 12, frameCount: 2, loop: true, targetEntityId: 'hip', futureClip: { keep: true },
      tracks: [
        { id: 'bone', type: 'bone', keyframes: [{ id: 'bone-0', frame: 0, value: { rotation: 0, futureKey: true } }] },
        { id: 'ik', type: 'ik', targetEntityId: 'target', keyframes: [{ id: 'ik-0', frame: 0, value: { mix: 1 } }] },
        { id: 'mesh-position', type: 'position', targetEntityId: 'mesh', keyframes: [{ id: 'mesh-0', frame: 0, value: { x: 0, y: 0 } }] }
      ]
    },
    {
      id: 'ambient', name: 'Ambient', fps: 12, frameCount: 1, loop: true, targetEntityId: 'bystander', futureAmbient: { keep: true },
      tracks: [{ id: 'ambient-position', type: 'position', keyframes: [{ id: 'ambient-0', frame: 0, value: { x: 0, y: 0 } }] }]
    }
  ];
  const document = () => ({
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main',
    scenes: [{ id: 'main', objects: [{ id: 'bystander' }] }],
    scene: [{ id: 'bystander' }],
    prefabs: [{ id: 'rig-prefab', name: 'Rig Prefab', rootEntityId: 'rig', revision: 1, entities: rigEntities() }],
    animations: clips()
  });
  const assertRig = (objects, ids) => {
    const byId = new Map(objects.map(entity => [entity.id, entity]));
    const get = sourceId => ids[sourceId];
    const root = byId.get(get('rig')), ik = byId.get(get('target')).components.IK, skin = byId.get(get('mesh')).components.Skin;
    assert.strictEqual(root.components.Skeleton.rootBoneId, get('hip'));
    assert.strictEqual(root.components.Skeleton.futureSkeleton.keep, true);
    assert.strictEqual(ik.skeletonRootId, get('rig'));
    assert.deepStrictEqual(ik.bones, [get('hip'), get('knee')]);
    assert.strictEqual(skin.skeletonRootId, get('rig'));
    assert.deepStrictEqual(skin.vertices[0].weights.map(weight => weight.boneId), [get('hip'), get('knee')]);
    assert.strictEqual(skin.futureSkin.keep, true);
    return root;
  };
  const assertClip = (clip, ids) => {
    assert.strictEqual(clip.targetEntityId, ids.hip);
    assert.strictEqual(clip.tracks.find(track => track.id === 'bone').targetEntityId, undefined);
    assert.strictEqual(clip.tracks.find(track => track.id === 'ik').targetEntityId, ids.target);
    assert.strictEqual(clip.tracks.find(track => track.id === 'mesh-position').targetEntityId, ids.mesh);
    assert.strictEqual(clip.futureClip.keep, true);
    assert.strictEqual(clip.tracks[0].keyframes[0].value.futureKey, true);
  };

  const source = document(), sourcePrefab = JSON.parse(JSON.stringify(source.prefabs[0])), sourcePose = JSON.parse(JSON.stringify(source.animations[0])), sourceAmbient = JSON.parse(JSON.stringify(source.animations[1]));
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load(source);
  const ids = { rig: 'rig-instance', hip: 'hip-instance', knee: 'knee-instance', target: 'target-instance', mesh: 'mesh-instance' };
  engine.prefabs.instantiate('rig-prefab', { idMap: ids });
  engine.prefabs.unpack(ids.knee);
  const objects = engine.document.scenes[0].objects;
  const root = assertRig(objects, ids);
  assert.ok(Object.values(ids).every(id => !objects.find(entity => entity.id === id).components?.PrefabInstance));
  assert.notStrictEqual(root.components.Animation.clipId, 'pose');
  assertClip(engine.document.animations.find(clip => clip.id === root.components.Animation.clipId), ids);
  assert.deepStrictEqual(engine.document.prefabs[0], sourcePrefab, 'unpack must preserve the Prefab Asset');
  assert.deepStrictEqual(engine.document.animations.find(clip => clip.id === 'pose'), sourcePose, 'unpack must preserve the source Clip');
  assert.deepStrictEqual(engine.document.animations.find(clip => clip.id === 'ambient'), sourceAmbient, 'unpack must preserve unrelated Clips');
  assert.deepStrictEqual(engine.skeleton.listBones(ids.rig), [ids.hip, ids.knee]);

  const linkedSource = document();
  linkedSource.prefabs = [];
  linkedSource.scenes[0].objects = [...rigEntities(), { id: 'bystander' }];
  linkedSource.scene = JSON.parse(JSON.stringify(linkedSource.scenes[0].objects));
  const linked = new AH2D.Engine({ physics: 'builtin' });
  linked.load(linkedSource);
  linked.prefabs.createAsset('rig', { id: 'linked-rig', name: 'Linked Rig' });
  const second = { rig: 'rig-two', hip: 'hip-two', knee: 'knee-two', target: 'target-two', mesh: 'mesh-two' };
  linked.prefabs.instantiate('linked-rig', { idMap: second });
  assert.strictEqual(linked.prefabs.deleteAsset('linked-rig', { unpackInstances: true }), true);
  const linkedObjects = linked.document.scenes[0].objects;
  assertRig(linkedObjects, { rig: 'rig', hip: 'hip', knee: 'knee', target: 'target', mesh: 'mesh' });
  const secondRoot = assertRig(linkedObjects, second);
  assertClip(linked.document.animations.find(clip => clip.id === secondRoot.components.Animation.clipId), second);
  assert.deepStrictEqual(linked.document.animations.find(clip => clip.id === 'pose'), sourcePose);
  assert.deepStrictEqual(linked.document.animations.find(clip => clip.id === 'ambient'), sourceAmbient);
  assert.strictEqual(linkedObjects.some(entity => entity.components?.PrefabInstance?.prefabId === 'linked-rig'), false);
};

const testPrefabValidationIsAtomicAndSnapshotsRemainDefinitionFree = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  const valid = {
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main',
    prefabs: [{ id: 'p', rootEntityId: 'source', revision: 1, entities: [{ id: 'source', name: 'Source', parentId: null }] }],
    scenes: [{ id: 'main', objects: [{ id: 'instance', name: 'Source', components: { PrefabInstance: {
      prefabId: 'p', sourceEntityId: 'source', instanceRootId: 'instance', prefabRevision: 1, overrides: {}
    } } }] }]
  };
  valid.scene = JSON.parse(JSON.stringify(valid.scenes[0].objects));
  engine.load(valid);
  const before = JSON.stringify(engine.document);
  const invalid = JSON.parse(JSON.stringify(valid));
  invalid.scenes[0].objects[0].components.PrefabInstance.sourceEntityId = 'missing';
  assert.throws(() => engine.load(invalid), error => error.code === 'E_PREFAB_INSTANCE_SOURCE_MISSING');
  assert.strictEqual(JSON.stringify(engine.document), before, 'invalid Prefab documents must fail before replacing live Engine state');
  const structural = JSON.parse(JSON.stringify(valid));
  structural.scenes[0].objects.push({ id: 'extra', parentId: 'instance' });
  assert.throws(() => engine.load(structural), error => error.code === 'E_PREFAB_STRUCTURAL_EDIT');
  assert.strictEqual(JSON.stringify(engine.document), before, 'a structural child outside the expanded instance must fail atomically');

  const snapshot = engine.captureSnapshot();
  assert.strictEqual(snapshot.runtime.version, 3);
  assert.strictEqual(snapshot.runtime.prefabs, undefined, 'active ECS snapshots intentionally omit reusable authoring definitions');
  assert.doesNotThrow(() => engine.restoreSnapshot(snapshot), 'definition-free expanded ECS snapshots must remain loadable');
  assert.strictEqual(engine.document.prefabs[0].id, 'p', 'snapshot restore must return the Universal authoring document');

  const staleEngine = new AH2D.Engine({ physics: 'builtin' });
  const stale = {
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main',
    prefabs: [{ id: 'stale-prefab', rootEntityId: 'source', revision: 2, entities: [{ id: 'source', name: 'Asset Name', foo: 'new', parentId: null }] }],
    scenes: [{ id: 'main', objects: [
      { id: 'stale-instance', name: 'Local Name', components: { PrefabInstance: {
        prefabId: 'stale-prefab', sourceEntityId: 'source', instanceRootId: 'stale-instance', prefabRevision: 1,
        overrides: { '/name': { op: 'replace', value: 'Local Name' } }
      } } },
      { id: 'current-instance', name: 'Asset Name', foo: 'new', components: { PrefabInstance: {
        prefabId: 'stale-prefab', sourceEntityId: 'source', instanceRootId: 'current-instance', prefabRevision: 2, overrides: {}
      } } }
    ] }]
  };
  stale.scene = JSON.parse(JSON.stringify(stale.scenes[0].objects));
  staleEngine.load(stale);
  assert.doesNotThrow(() => staleEngine.prefabs.apply('stale-instance', { paths: '/name' }));
  assert.strictEqual(staleEngine.prefabs.get('stale-prefab').revision, 3);
  assert.strictEqual(staleEngine.document.scenes[0].objects.find(item => item.id === 'stale-instance').components.PrefabInstance.prefabRevision, 1, 'an initiating stale member must remain marked stale');
  assert.strictEqual(staleEngine.document.scenes[0].objects.find(item => item.id === 'current-instance').components.PrefabInstance.prefabRevision, 3, 'a previously-current member may advance after path sync');
  staleEngine.prefabs.setOverride('current-instance', '/foo', 'applied');
  assert.doesNotThrow(() => staleEngine.prefabs.apply('current-instance', { paths: '/foo' }));
  const staleEntity = staleEngine.document.scenes[0].objects.find(item => item.id === 'stale-instance');
  assert.strictEqual(staleEntity.foo, undefined, 'path sync must not partially mutate a stale instance group');
  assert.strictEqual(staleEntity.components.PrefabInstance.prefabRevision, 1);

  const staleAddEngine = new AH2D.Engine({ physics: 'builtin' });
  const staleAdd = {
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main',
    prefabs: [{ id: 'p', rootEntityId: 'source', revision: 2, entities: [{ id: 'source', foo: 'asset' }] }],
    scenes: [{ id: 'main', objects: [
      { id: 'stale', foo: 'local', components: { PrefabInstance: {
        prefabId: 'p', sourceEntityId: 'source', instanceRootId: 'stale', prefabRevision: 1,
        overrides: { '/foo': { op: 'add', value: 'local', futureRecord: { keep: true } } }
      } } },
      { id: 'current', foo: 'asset', components: { PrefabInstance: {
        prefabId: 'p', sourceEntityId: 'source', instanceRootId: 'current', prefabRevision: 2, overrides: {}
      } } }
    ] }]
  };
  staleAdd.scene = JSON.parse(JSON.stringify(staleAdd.scenes[0].objects));
  staleAddEngine.load(staleAdd);
  assert.doesNotThrow(() => staleAddEngine.prefabs.apply('stale', { paths: '/foo' }));
  assert.strictEqual(staleAddEngine.prefabs.get('p').entities[0].foo, 'local', 'stale add must rebase to replace when the current Asset owns the path');
  assert.strictEqual(staleAddEngine.document.scenes[0].objects.find(item => item.id === 'current').foo, 'local');
  assert.strictEqual(staleAddEngine.document.scenes[0].objects.find(item => item.id === 'stale').components.PrefabInstance.prefabRevision, 1);

  const redundantEngine = new AH2D.Engine({ physics: 'builtin' });
  const redundant = {
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main',
    prefabs: [{ id: 'p', rootEntityId: 'source', revision: 2, entities: [{ id: 'source' }] }],
    scenes: [{ id: 'main', objects: [{ id: 'stale', components: { PrefabInstance: {
      prefabId: 'p', sourceEntityId: 'source', instanceRootId: 'stale', prefabRevision: 1,
      overrides: { '/foo': { op: 'remove' } }
    } } }] }]
  };
  redundant.scene = JSON.parse(JSON.stringify(redundant.scenes[0].objects));
  redundantEngine.load(redundant);
  const redundantApply = redundantEngine.prefabs.apply('stale', { paths: '/foo' });
  assert.strictEqual(redundantApply.revision, 2, 'clearing a stale override already represented by the Asset must not invent a revision');
  assert.deepStrictEqual(redundantEngine.document.scenes[0].objects[0].components.PrefabInstance.overrides, {});
};

const testPrefabArrayOverrideCoordinatesAndStalePromotion = () => {
  const createArrayEngine = values => {
    const engine = new AH2D.Engine({ physics: 'builtin' });
    const marker = instanceRootId => ({
      prefabId: 'p', sourceEntityId: 'source', instanceRootId, prefabRevision: 1, overrides: {}
    });
    const project = {
      format: 'AH2D', version: 4,
      dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
      currentSceneId: 'main',
      prefabs: [{ id: 'p', rootEntityId: 'source', revision: 1, entities: [{ id: 'source', values: [...values] }] }],
      scenes: [{ id: 'main', objects: [
        { id: 'a', values: [...values], components: { PrefabInstance: marker('a') } },
        { id: 'b', values: [...values], components: { PrefabInstance: marker('b') } }
      ] }]
    };
    project.scene = JSON.parse(JSON.stringify(project.scenes[0].objects));
    engine.load(project);
    return engine;
  };
  const entity = (engine, id) => engine.document.scenes[0].objects.find(item => item.id === id);

  const appended = createArrayEngine(['a', 'b']);
  appended.prefabs.removeOverride('b', '/values/0');
  appended.prefabs.setOverride('a', '/values/2', 'c');
  assert.doesNotThrow(() => appended.prefabs.apply('a', { paths: '/values/2' }));
  assert.deepStrictEqual(entity(appended, 'b').values, ['b', 'c'], 'Asset append coordinates must be rebuilt around a sibling instance removal');
  assert.deepStrictEqual(entity(appended, 'b').components.PrefabInstance.overrides, { '/values/0': { op: 'remove' } });

  const removed = createArrayEngine(['a', 'b', 'c']);
  removed.prefabs.removeOverride('b', '/values/0');
  removed.prefabs.removeOverride('a', '/values/2');
  assert.doesNotThrow(() => removed.prefabs.apply('a', { paths: '/values/2' }));
  assert.deepStrictEqual(entity(removed, 'b').values, ['b'], 'Asset removal coordinates must be rebuilt around a sibling instance removal');

  const redundantRemoval = createArrayEngine(['a', 'b', 'c']);
  redundantRemoval.prefabs.removeOverride('b', '/values/0');
  redundantRemoval.prefabs.setOverride('b', '/values/1', 'X');
  redundantRemoval.prefabs.removeOverride('a', '/values/0');
  redundantRemoval.prefabs.apply('a', { paths: '/values/0' });
  assert.deepStrictEqual(entity(redundantRemoval, 'b').values, ['b', 'X']);
  assert.deepStrictEqual(entity(redundantRemoval, 'b').components.PrefabInstance.overrides, {
    '/values/1': { op: 'replace', value: 'X' }
  }, 'a local removal matching the Asset removal must clear without claiming the whole array');

  const replaced = createArrayEngine(['a', 'b', 'c']);
  replaced.prefabs.removeOverride('b', '/values/0');
  replaced.prefabs.setOverride('a', '/values/2', 'X');
  assert.doesNotThrow(() => replaced.prefabs.apply('a', { paths: '/values/2' }));
  assert.deepStrictEqual(entity(replaced, 'b').values, ['b', 'X'], 'Asset replacement coordinates must be rebuilt around structural sibling overrides');

  const nestedValues = [{ value: 'a' }, { value: 'b' }, { value: 'c' }];
  const nested = createArrayEngine(nestedValues);
  nested.prefabs.removeOverride('b', '/values/0');
  nested.prefabs.setOverride('a', '/values/2/value', 'X');
  nested.prefabs.apply('a', { paths: '/values/2/value' });
  assert.deepStrictEqual(entity(nested, 'b').values, [{ value: 'b' }, { value: 'X' }], 'nested fields inside shifted array elements must use Asset coordinates');

  const partial = createArrayEngine(['a', 'b', 'c']);
  partial.prefabs.setOverride('a', '/values/2', 'X');
  partial.prefabs.removeOverride('a', '/values/0');
  partial.prefabs.apply('a', { paths: '/values/0' });
  assert.deepStrictEqual(entity(partial, 'a').values, ['b', 'X']);
  assert.deepStrictEqual(entity(partial, 'a').components.PrefabInstance.overrides, {
    '/values/1': { op: 'replace', value: 'X' }
  }, 'partial Apply must rebase earlier sibling indexes on the initiating instance');

  const staged = createArrayEngine(['a', 'b']);
  staged.prefabs.setOverride('b', '/values/2', 'x');
  staged.prefabs.setOverride('b', '/values/3', 'y');
  staged.prefabs.setOverride('a', '/values/2', 'c');
  staged.prefabs.apply('a', { paths: '/values/2' });
  assert.deepStrictEqual(entity(staged, 'b').values, ['a', 'b', 'c', 'x', 'y']);
  assert.deepStrictEqual(entity(staged, 'b').components.PrefabInstance.overrides, {
    '/values/3': { op: 'add', value: 'x' },
    '/values/4': { op: 'add', value: 'y' }
  }, 'array pointer shifts must be staged so adjacent records cannot overwrite one another');

  const incremental = createArrayEngine(['a', 'b', 'c', 'd']);
  incremental.prefabs.setOverride('b', '/values/2', 'd');
  incremental.prefabs.removeOverride('a', '/values/0');
  incremental.prefabs.removeOverride('a', '/values/1');
  incremental.prefabs.apply('a');
  assert.deepStrictEqual(incremental.prefabs.get('p').entities[0].values, ['b', 'd']);
  assert.deepStrictEqual(entity(incremental, 'b').values, ['b', 'd', 'd']);
  assert.deepStrictEqual(entity(incremental, 'b').components.PrefabInstance.overrides, {
    '/values': { op: 'replace', value: ['b', 'd', 'd'] }
  }, 'each array change must sync against its own intermediate Asset source');

  const revertRemove = createArrayEngine(['a', 'b', 'c']);
  revertRemove.prefabs.removeOverride('a', '/values/0');
  revertRemove.prefabs.removeOverride('a', '/values/1');
  revertRemove.prefabs.revert('a', '/values/0');
  assert.deepStrictEqual(entity(revertRemove, 'a').values, ['a', 'b']);
  assert.deepStrictEqual(entity(revertRemove, 'a').components.PrefabInstance.overrides, {
    '/values/2': { op: 'remove' }
  });

  const revertAdd = createArrayEngine(['a', 'b']);
  revertAdd.prefabs.setOverride('a', '/values/2', 'x');
  revertAdd.prefabs.setOverride('a', '/values/3', 'y');
  revertAdd.prefabs.revert('a', '/values/2');
  assert.deepStrictEqual(entity(revertAdd, 'a').values, ['a', 'b', 'y']);
  assert.deepStrictEqual(entity(revertAdd, 'a').components.PrefabInstance.overrides, {
    '/values/2': { op: 'add', value: 'y' }
  });

  const reordered = createArrayEngine(['a', 'b']);
  reordered.prefabs.setOverride('a', '/values/2', 'x');
  reordered.prefabs.setOverride('a', '/values/3', 'y');
  assert.doesNotThrow(() => reordered.prefabs.setOverride('a', '/values/2', 'X'));
  assert.deepStrictEqual(entity(reordered, 'a').values, ['a', 'b', 'X', 'y']);
  assert.deepStrictEqual(Object.keys(entity(reordered, 'a').components.PrefabInstance.overrides), ['/values/2', '/values/3'], 'editing a record must retain its semantic insertion slot');

  const promotedLocal = createArrayEngine(['a', 'b', 'c']);
  promotedLocal.prefabs.removeOverride('a', '/values/0');
  assert.doesNotThrow(() => promotedLocal.prefabs.setOverride('a', '/values/0', 'B'));
  assert.deepStrictEqual(entity(promotedLocal, 'a').values, ['B', 'c']);
  assert.deepStrictEqual(entity(promotedLocal, 'a').components.PrefabInstance.overrides, {
    '/values': { op: 'replace', value: ['B', 'c'] }
  }, 'an ambiguous repeated array index must promote to a reconstructable branch override');

  const staleEngine = new AH2D.Engine({ physics: 'builtin' });
  const staleProject = {
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main',
    prefabs: [{ id: 'p', rootEntityId: 'source', revision: 2, entities: [{ id: 'source' }] }],
    scenes: [{ id: 'main', objects: [
      { id: 'stale', branch: { x: 9, sibling: 2 }, components: { PrefabInstance: {
        prefabId: 'p', sourceEntityId: 'source', instanceRootId: 'stale', prefabRevision: 1,
        overrides: { '/branch/x': { op: 'replace', value: 9 } }
      } } },
      { id: 'current', components: { PrefabInstance: {
        prefabId: 'p', sourceEntityId: 'source', instanceRootId: 'current', prefabRevision: 2, overrides: {}
      } } }
    ] }]
  };
  staleProject.scene = JSON.parse(JSON.stringify(staleProject.scenes[0].objects));
  staleEngine.load(staleProject);
  assert.doesNotThrow(() => staleEngine.prefabs.apply('stale', { paths: '/branch/x' }));
  assert.deepStrictEqual(staleEngine.prefabs.get('p').entities[0].branch, { x: 9, sibling: 2 }, 'a stale descendant with a removed parent must promote to its nearest applicable ancestor');
  assert.strictEqual(entity(staleEngine, 'stale').components.PrefabInstance.prefabRevision, 1);
  assert.strictEqual(entity(staleEngine, 'current').components.PrefabInstance.prefabRevision, 3);
};

const testRealAnimationClipsAndTimelineSampling = () => {
  const clip = {
    id: 'knight-run', name: 'Knight Run', fps: 10, frameCount: 4, loop: false,
    tracks: [
      { id: 'position', type: 'position', targetEntityId: 'body', keyframes: [
        { id: 'position-0', frame: 0, value: { x: 0, y: 0 } },
        { id: 'position-3', frame: 3, value: { x: 30, y: 6 } }
      ] },
      { id: 'rotation', type: 'rotation', targetEntityId: 'body', keyframes: [
        { id: 'rotation-0', frame: 0, value: 0 },
        { id: 'rotation-3', frame: 3, value: 90 }
      ] },
      { id: 'sprite', type: 'sprite', targetEntityId: 'body', keyframes: [
        { id: 'sprite-0', frame: 0, value: { spriteFrame: 0 } },
        { id: 'sprite-2', frame: 2, value: { frame: 2, sourceRect: { x: 64, y: 0, width: 32, height: 32 } } }
      ] },
      { id: 'hitbox', type: 'hitbox', targetEntityId: 'body', keyframes: [
        { id: 'hitbox-1', frame: 1, value: { colliderId: 'attack', enabled: true, width: 18, height: 12 } }
      ] },
      { id: 'events', type: 'event', keyframes: [
        { id: 'footstep-2', frame: 2, value: { name: 'Footstep', payload: { foot: 'left' } } }
      ] }
    ]
  };
  const objects = [
    { id: 'root', components: { Animation: { clipId: 'knight-run', playing: true, time: 0, speed: 0, loop: false } } },
    { id: 'body', parentId: 'root', components: { Transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, Renderable: { frame: 0 } } }
  ];
  const document = {
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main', meta: { currentSceneId: 'main' },
    prefabs: [], animations: [clip],
    scenes: [{ id: 'main', name: 'Main', objects }], scene: JSON.parse(JSON.stringify(objects))
  };
  const engine = new AH2D.Engine({ physics: 'builtin' });
  const events = [];
  const completed = [];
  engine.events.on('animation:event', event => events.push(event));
  engine.events.on('animation:complete', event => completed.push(event));
  engine.load(document);
  assert.strictEqual(engine.animation.getClip('knight-run').name, 'Knight Run');
  assert.strictEqual(engine.animation.getClip('Knight Run').id, 'knight-run');
  const normalizedSpriteValue = engine.animation.getClip('knight-run').tracks.find(track => track.type === 'sprite').keyframes[0].value;
  assert.strictEqual(normalizedSpriteValue.frame, 0, 'legacy Sprite frame aliases normalize before Runtime sampling');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(normalizedSpriteValue, 'spriteFrame'), false, 'Runtime Clip data stays canonical');

  const legacyLibrary = new AH2D.AnimationSystem(engine);
  legacyLibrary.load([
    { name: 'Walk Left', fps: 12, frames: 2, loop: true, events: [] },
    { name: 'Walk-Left', fps: 12, frames: 2, loop: true, events: [] },
    { name: 'Walk Left', fps: 12, frames: 2, loop: true, events: [] }
  ]);
  assert.deepStrictEqual([...legacyLibrary.clips.keys()], ['walk-left', 'walk-left-2', 'walk-left-3']);
  assert.strictEqual(legacyLibrary.resolve('Walk Left'), null, 'duplicate legacy display names remain intentionally ambiguous');

  engine.update(0.2);
  assert.strictEqual(engine.ecs.get('root', 'Animation').time, 0, 'speed zero must freeze playback');
  assert.strictEqual(engine.ecs.get('body', 'Renderable').frame, 0);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(engine.ecs.get('body', 'Renderable'), 'spriteFrame'), false);
  engine.ecs.get('root', 'Animation').speed = 1;
  engine.update(0.15);
  near(engine.ecs.get('body', 'Transform').x, 15);
  near(engine.ecs.get('body', 'Transform').y, 3);
  near(engine.ecs.get('body', 'Transform').rotation, 45);
  assert.strictEqual(engine.ecs.get('root', 'Animation').sampledHitboxes[0].colliderId, 'attack');
  engine.update(0.1);
  assert.strictEqual(events.length, 1, 'a crossed event must fire exactly once');
  assert.strictEqual(events[0].name, 'Footstep');
  assert.strictEqual(events[0].payload.foot, 'left');
  assert.strictEqual(events[0].hitboxes[0].colliderId, 'attack');
  assert.strictEqual(engine.ecs.get('body', 'Renderable').frame, 2, 'sprite tracks use step sampling');

  engine.animation.setFrame('root', 3);
  near(engine.ecs.get('body', 'Transform').x, 30);
  near(engine.ecs.get('body', 'Transform').rotation, 90);
  assert.strictEqual(events.length, 1, 'seeking must not emit timeline events by default');
  engine.animation.play('root');
  engine.update(0.25);
  const animation = engine.ecs.get('root', 'Animation');
  assert.strictEqual(animation.playing, false);
  assert.strictEqual(animation.completed, true);
  assert.strictEqual(animation.time, 0.4);
  assert.strictEqual(animation.frame, 3);
  assert.strictEqual(completed.length, 1);

  animation.loop = true;
  animation.playing = true;
  animation.completed = false;
  animation.time = 0.35;
  engine.update(0.1);
  near(animation.time, 0.05);
  assert.strictEqual(animation.playing, true, 'looping playback must remain active');

  const playSnapshot = engine.captureSnapshot();
  const capturedAnimationTime = engine.ecs.get('root', 'Animation').time;
  assert.strictEqual(playSnapshot.runtime.animations, undefined, 'runtime ECS snapshots remain definition-free');
  engine.animation.load([]);
  assert.doesNotThrow(
    () => engine.restoreSnapshot(playSnapshot),
    'restoring an animated Play snapshot must accept definition-free runtime data'
  );
  assert.strictEqual(engine.animation.getClip('knight-run').name, 'Knight Run', 'snapshot restore must reconnect the authoring clip library');
  assert.strictEqual(engine.document.animations[0].id, 'knight-run', 'snapshot restore must preserve authored Animation Clips');
  near(engine.ecs.get('root', 'Animation').time, capturedAnimationTime);

  const bridgeEngine = new AH2D.Engine({ physics: 'builtin' });
  const bridge = new AH2D.EditorBridge(bridgeEngine);
  assert.strictEqual(bridge.sync({ scene: objects, animations: [clip] }), true);
  assert.strictEqual(bridgeEngine.animation.getClip('knight-run').frameCount, 4);
  assert.strictEqual(bridge.sync({ scene: objects, animations: [clip] }), false, 'Animation Clips participate in bridge change detection');
};

const testAnimationEventBoundariesAndPrefabTargetResolution = () => {
  const clip = {
    id: 'event-boundaries', name: 'Event Boundaries', fps: 10, frameCount: 4, loop: false,
    tracks: [
      { id: 'hitbox', type: 'hitbox', keyframes: [
        { id: 'hitbox-old', frame: 0, value: { colliderId: 'old', enabled: true } },
        { id: 'hitbox-new', frame: 2, value: { colliderId: 'new', enabled: true } }
      ] },
      { id: 'events', type: 'event', keyframes: [
        { id: 'start', frame: 0, value: { name: 'Start' } },
        { id: 'middle', frame: 1, value: { name: 'Middle' } },
        { id: 'late', frame: 3, value: { name: 'Late' } }
      ] }
    ]
  };
  const objects = [{ id: 'animated', components: { Animation: { clipId: clip.id, playing: true, time: 0, loop: false } } }];
  const engine = new AH2D.Engine({ physics: 'builtin' });
  const events = [];
  engine.events.on('animation:event', event => events.push(event));
  engine.load({
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main', prefabs: [], animations: [clip],
    scenes: [{ id: 'main', name: 'Main', objects }], scene: JSON.parse(JSON.stringify(objects))
  });

  engine.update(0.25);
  assert.deepStrictEqual(events.map(event => event.name), ['Middle']);
  assert.strictEqual(events[0].hitboxes[0].colliderId, 'old', 'an event samples hitboxes at its own occurrence');
  assert.strictEqual(engine.ecs.get('animated', 'Animation').sampledHitboxes[0].colliderId, 'new', 'the visible pose remains sampled at the update endpoint');
  engine.update(0.1);
  assert.deepStrictEqual(events.map(event => event.name), ['Middle', 'Late']);
  assert.deepStrictEqual(events.map(event => event.hitboxes[0].colliderId), ['old', 'new']);
  engine.update(0.1);
  assert.strictEqual(events.some(event => event.name === 'Start'), false, 'a non-loop frame-zero event must not fire at completion');

  const animation = engine.ecs.get('animated', 'Animation');
  animation.loop = true;
  animation.playing = true;
  animation.completed = false;
  animation.time = 0.35;
  events.length = 0;
  engine.update(0.1);
  assert.deepStrictEqual(events.map(event => event.name), ['Start'], 'a frame-zero event fires once when a loop boundary is crossed');

  const instanceEngine = new AH2D.Engine({ physics: 'builtin' });
  const instanceClip = {
    id: 'prefab-motion', name: 'Prefab Motion', fps: 10, frameCount: 1, loop: true,
    tracks: [{ id: 'position', type: 'position', targetEntityId: 'body', keyframes: [
      { id: 'position-0', frame: 0, value: { x: 42, y: 7 } }
    ] }]
  };
  const marker = (sourceEntityId, instanceRootId) => ({ prefabId: 'actor', sourceEntityId, instanceRootId, prefabRevision: 1, overrides: {} });
  instanceEngine.createEntity({ id: 'actor-a', components: { Animation: { clipId: instanceClip.id, playing: true }, PrefabInstance: marker('root', 'actor-a') } });
  instanceEngine.createEntity({ id: 'body', parentId: 'actor-a', components: { Transform: { x: 0, y: 0 }, PrefabInstance: marker('body', 'actor-a') } });
  instanceEngine.createEntity({ id: 'actor-b', components: { Animation: { clipId: instanceClip.id, playing: true }, PrefabInstance: marker('root', 'actor-b') } });
  instanceEngine.createEntity({ id: 'body-b', parentId: 'actor-b', components: { Transform: { x: 0, y: 0 }, PrefabInstance: marker('body', 'actor-b') } });
  const isolatedClip = {
    id: 'isolated-motion', name: 'Isolated Motion', fps: 10, frameCount: 1, loop: true,
    tracks: [{ id: 'isolated-position', type: 'position', targetEntityId: 'foreign-body', keyframes: [
      { id: 'isolated-position-0', frame: 0, value: { x: 99 } }
    ] }]
  };
  instanceEngine.createEntity({ id: 'foreign-body', components: { Transform: { x: 3, y: 0 } } });
  instanceEngine.createEntity({ id: 'actor-c', components: {
    Animation: { clipId: isolatedClip.id, playing: true }, PrefabInstance: marker('root', 'actor-c')
  } });
  instanceEngine.animation.load([instanceClip, isolatedClip]);
  instanceEngine.update(0);
  assert.strictEqual(instanceEngine.ecs.get('body', 'Transform').x, 42);
  assert.strictEqual(instanceEngine.ecs.get('body-b', 'Transform').x, 42, 'Prefab source targets resolve inside the Animation owner instance');
  assert.strictEqual(instanceEngine.ecs.get('foreign-body', 'Transform').x, 3, 'a marked Animation owner cannot fall back outside its exact Prefab group');

  const atomicEngine = new AH2D.Engine({ physics: 'builtin' });
  atomicEngine.load({ scene: [{ id: 'kept' }] });
  const previousDocument = JSON.stringify(atomicEngine.document);
  assert.throws(
    () => atomicEngine.load({ scene: [{ id: 'broken', components: { Animation: { clipId: 'missing', duration: 1 } } }] }),
    error => error?.code === 'E_ANIMATION_CLIP_REFERENCE'
  );
  assert.strictEqual(JSON.stringify(atomicEngine.document), previousDocument, 'a dangling Animation Clip load must be atomic');
  assert.strictEqual(atomicEngine.ecs.entities.has('kept'), true);
  assert.strictEqual(atomicEngine.ecs.entities.has('broken'), false);
};

const skeletonProject = ({ includeIK = true, includeSkin = false, animations = [] } = {}) => {
  const objects = [
    {
      id: 'rig',
      components: {
        Transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        Skeleton: { rootBoneId: 'upper', enabled: true, solveIK: true },
        ...(animations.length ? { Animation: { clipId: animations[0].id, playing: true, speed: 0 } } : {})
      }
    },
    { id: 'upper', parentId: 'rig', components: { Transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, Bone: { length: 10 } } },
    { id: 'lower', parentId: 'upper', components: { Transform: { x: 10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, Bone: { length: 10 } } }
  ];
  if (includeIK) objects.push({
    id: 'hand-target',
    components: {
      Transform: { x: 10, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
      IK: { skeletonRootId: 'rig', bones: ['upper', 'lower'], mix: 1, iterations: 40, tolerance: 0.001, enabled: true, bendDirection: 1 }
    }
  });
  if (includeSkin) objects.push({
    id: 'skin',
    components: {
      Transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      Skin: {
        skeletonRootId: 'rig',
        assetId: 'skin-image',
        vertices: [
          { x: 0, y: 0, weights: [{ boneId: 'upper', weight: 1 }] },
          { x: 10, y: 0, weights: [{ boneId: 'upper', weight: 1 }] },
          { x: 10, y: 4, weights: [{ boneId: 'upper', weight: 1 }] },
          { x: 0, y: 4, weights: [{ boneId: 'upper', weight: 1 }] }
        ],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        indices: [0, 1, 2, 0, 2, 3]
      }
    }
  });
  return {
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main', prefabs: [], animations,
    assets: [{ id: 'skin-image', imageSrc: '/skin.png' }],
    scenes: [{ id: 'main', name: 'Main', objects }],
    scene: JSON.parse(JSON.stringify(objects))
  };
};

const testSkeletonForwardKinematicsAndCCD = () => {
  const inheritance = new AH2D.Engine({ physics: 'builtin' });
  inheritance.load(skeletonProject({ includeIK: false }));
  Object.assign(inheritance.ecs.get('rig', 'Transform'), { rotation: 90, scaleX: 2, scaleY: 2 });
  Object.assign(inheritance.ecs.get('upper', 'Transform'), { x: 5, rotation: 10, scaleX: 1.5, scaleY: 0.5 });
  Object.assign(inheritance.ecs.get('upper', 'Bone'), { inheritRotation: false, inheritScale: false });
  inheritance.transform.update();
  let inheritedWorld = inheritance.transform.getWorld('upper');
  near(inheritedWorld.x, 0, 1e-8, 'Bone origin still follows its parent matrix');
  near(inheritedWorld.y, 10, 1e-8, 'Bone origin still follows its parent matrix');
  near(inheritedWorld.rotation, 10, 1e-8, 'Bone can opt out of parent rotation');
  near(inheritedWorld.scaleX, 1.5, 1e-8, 'Bone can opt out of parent scale');
  near(inheritedWorld.scaleY, 0.5, 1e-8, 'Bone can opt out of parent scale');
  inheritance.transform.setWorld('upper', { x: 20, y: 30, rotation: 25, scaleX: 2, scaleY: 3 });
  inheritedWorld = inheritance.transform.getWorld('upper');
  near(inheritedWorld.x, 20, 1e-8, 'setWorld converts non-inheriting Bone position correctly');
  near(inheritedWorld.y, 30, 1e-8, 'setWorld converts non-inheriting Bone position correctly');
  near(inheritedWorld.rotation, 25, 1e-8, 'setWorld converts non-inheriting Bone rotation correctly');
  near(inheritedWorld.scaleX, 2, 1e-8, 'setWorld converts non-inheriting Bone scale correctly');
  near(inheritedWorld.scaleY, 3, 1e-8, 'setWorld converts non-inheriting Bone scale correctly');
  Object.assign(inheritance.ecs.get('upper', 'Transform'), { x: 5, y: 0, rotation: 10, scaleX: 1.5, scaleY: 0.5 });
  Object.assign(inheritance.ecs.get('upper', 'Bone'), { inheritRotation: true, inheritScale: true });
  inheritance.transform.update();
  inheritedWorld = inheritance.transform.getWorld('upper');
  near(inheritedWorld.rotation, 100, 1e-8, 'Bone inheritance changes invalidate Transform.world');
  near(inheritedWorld.scaleX, 3, 1e-8, 'Bone inherits parent scale by default');
  near(inheritedWorld.scaleY, 1, 1e-8, 'Bone inherits parent scale by default');

  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load(skeletonProject());
  assert.ok(engine.skeleton instanceof AH2D.SkeletonSystem);
  assert.deepStrictEqual(engine.skeleton.listBones('rig'), ['upper', 'lower']);
  const bindPose = engine.skeleton.getPose('rig');
  near(bindPose.upper.tip.x, 10, 1e-8, 'upper bind tip x');
  near(bindPose.lower.tip.x, 20, 1e-8, 'nested FK tip x');
  near(bindPose.lower.tip.y, 0, 1e-8, 'nested FK tip y');

  engine.update(0);
  const solved = engine.skeleton.solve('hand-target');
  assert.ok(solved.distance <= 0.01, `CCD chain must reach its target, distance was ${solved.distance}`);
  near(solved.end.x, 10, 0.01, 'IK end x');
  near(solved.end.y, 10, 0.01, 'IK end y');
  assert.deepStrictEqual(engine.ecs.get('rig', 'Skeleton').boneMatrices.lower, engine.transform.getWorldMatrix('lower'));

  const upper = engine.ecs.get('upper', 'Transform');
  const lower = engine.ecs.get('lower', 'Transform');
  const target = engine.ecs.get('hand-target', 'Transform');
  const ik = engine.ecs.get('hand-target', 'IK');
  ik.enabled = false;
  target.x = -12; target.y = 7;
  engine.update(0);
  near(upper.rotation, 0, 1e-10, 'disabled IK restores the unconstrained upper base pose');
  near(lower.rotation, 0, 1e-10, 'disabled IK restores the unconstrained lower base pose');

  upper.rotation = 0; lower.rotation = 0;
  ik.enabled = true; ik.mix = 0;
  target.x = 10; target.y = 10;
  engine.update(0);
  near(upper.rotation, 0, 1e-10, 'zero-mix IK upper rotation');
  near(lower.rotation, 0, 1e-10, 'zero-mix IK lower rotation');

  ik.mix = 0.5;
  engine.update(0);
  assert.ok(Math.abs(lower.rotation) > 1, 'partial-mix IK must influence the chain');
  assert.ok(Math.abs(lower.rotation) < 89, 'partial-mix IK must blend instead of converging to the full solved pose');
  const partialPose = [upper.rotation, lower.rotation];
  engine.update(0);
  near(upper.rotation, partialPose[0], 1e-10, 'repeated IK updates retain the same mixed upper pose');
  near(lower.rotation, partialPose[1], 1e-10, 'repeated IK updates must not accumulate mix toward the full solution');

  upper.rotation = 0; lower.rotation = 0;
  ik.mix = 1; ik.bendDirection = 1;
  target.x = 15; target.y = 0;
  const bendPositive = engine.skeleton.solve('hand-target');
  assert.ok(bendPositive.distance <= 0.01, 'CCD must contract a collinear multi-Bone chain');
  assert.ok(upper.rotation > 0, 'positive bendDirection selects the positive elbow side');
  upper.rotation = 0; lower.rotation = 0;
  ik.bendDirection = -1;
  const bendNegative = engine.skeleton.solve('hand-target');
  assert.ok(bendNegative.distance <= 0.01, 'negative-bend CCD must still reach the target');
  assert.ok(upper.rotation < 0, 'negative bendDirection selects the negative elbow side');
};

const testLinearBlendSkinningAndSnapshotRestore = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load(skeletonProject({ includeIK: false, includeSkin: true }));
  assert.deepStrictEqual(engine.ecs.get('skin', 'Skin').deformedVertices[1], { x: 10, y: 0 });

  engine.ecs.get('upper', 'Transform').rotation = 90;
  engine.update(0);
  let vertices = engine.ecs.get('skin', 'Skin').deformedVertices;
  near(vertices[1].x, 0, 1e-8, 'LBS rotated vertex x');
  near(vertices[1].y, 10, 1e-8, 'LBS rotated vertex y');
  near(vertices[2].x, -4, 1e-8, 'LBS preserves authored local vertex offset');
  near(vertices[2].y, 10, 1e-8, 'LBS preserves authored local vertex offset');

  const snapshot = engine.captureSnapshot();
  engine.ecs.get('upper', 'Transform').rotation = 180;
  engine.update(0);
  near(engine.ecs.get('skin', 'Skin').deformedVertices[1].x, -10, 1e-8);
  engine.restoreSnapshot(snapshot);
  near(engine.ecs.get('upper', 'Transform').rotation, 90, 1e-8, 'snapshot restores animated Bone local pose');
  vertices = engine.ecs.get('skin', 'Skin').deformedVertices;
  near(vertices[1].x, 0, 1e-8, 'snapshot restores bind-cache deformation x');
  near(vertices[1].y, 10, 1e-8, 'snapshot restores bind-cache deformation y');

  engine.ecs.remove('upper', 'Bone');
  engine.skeleton.deform('skin');
  assert.strictEqual(engine.skeleton.bindings.get('skin').inverseBindMatrices.has('upper'), false, 'removing a referenced Bone invalidates its bind cache');
  engine.ecs.add('upper', 'Bone', { length: 10 });
  engine.skeleton.deform('skin');
  assert.strictEqual(engine.skeleton.bindings.get('skin').inverseBindMatrices.has('upper'), true, 'adding a referenced Bone rebuilds its bind cache');
  assert.deepStrictEqual(engine.ecs.get('skin', 'Skin').deformedVertices[1], { x: 10, y: 0 }, 'a newly-added Bone is captured in its current bind pose');
};

const testSkeletonBindCacheSurvivesRuntimeLifecycle = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load(skeletonProject({ includeIK: false, includeSkin: true }));
  engine.ecs.get('upper', 'Transform').rotation = 45;
  engine.update(0);
  const originalInverse = engine.skeleton.bindings.get('skin').inverseBindMatrices.get('upper').slice();

  engine.createEntity({ id: 'unrelated-parent', components: { Transform: { x: 7 } } });
  engine.createEntity({ id: 'unrelated-child', components: { Transform: { y: 4 } } });
  engine.reparent('unrelated-child', 'unrelated-parent');
  engine.destroyEntity('unrelated-child');
  assert.deepStrictEqual(
    engine.skeleton.bindings.get('skin').inverseBindMatrices.get('upper'),
    originalInverse,
    'unrelated graph mutation and destruction must not recapture an animated bind pose'
  );

  engine.createEntity({ id: 'bone-parent', parentId: 'rig', components: { Transform: { x: 5 } } });
  engine.reparent('upper', 'bone-parent');
  assert.deepStrictEqual(
    engine.skeleton.bindings.get('skin').inverseBindMatrices.get('upper'),
    originalInverse,
    'reparenting a live Bone reconciles topology while preserving its authored inverse bind'
  );
  engine.skeleton.rebind('skin');
  assert.notDeepStrictEqual(
    engine.skeleton.bindings.get('skin').inverseBindMatrices.get('upper'),
    originalInverse,
    'an explicit rebind deliberately captures the current topology and pose'
  );
};

const testSkeletonPrefabReferencesAndAnimationTracks = () => {
  const marker = (sourceEntityId, instanceRootId) => ({
    prefabId: 'rig-prefab', sourceEntityId, instanceRootId, prefabRevision: 1, overrides: {}
  });
  const engine = new AH2D.Engine({ physics: 'builtin' });
  for (const suffix of ['a', 'b']) {
    const rootId = `rig-${suffix}`;
    const boneId = `bone-${suffix}`;
    const skinId = `skin-${suffix}`;
    engine.createEntity({ id: rootId, components: {
      Transform: {}, Skeleton: { rootBoneId: 'bone' }, PrefabInstance: marker('rig', rootId)
    } });
    engine.createEntity({ id: boneId, parentId: rootId, components: {
      Transform: {}, Bone: { length: 10 }, PrefabInstance: marker('bone', rootId)
    } });
    engine.createEntity({ id: skinId, components: {
      Transform: {},
      Skin: { skeletonRootId: 'rig', vertices: [{ x: 10, y: 0, weights: [{ boneId: 'bone', weight: 1 }] }] },
      PrefabInstance: marker('skin', rootId)
    } });
  }
  engine.skeleton.rebind();
  assert.deepStrictEqual(engine.skeleton.listBones('rig-a'), ['bone-a']);
  assert.deepStrictEqual(engine.skeleton.listBones('rig-b'), ['bone-b']);
  engine.ecs.get('bone-a', 'Transform').rotation = 90;
  engine.transform.update();
  engine.skeleton.deform();
  near(engine.ecs.get('skin-a', 'Skin').deformedVertices[0].x, 0, 1e-8, 'Prefab A source Bone maps to instance A');
  near(engine.ecs.get('skin-a', 'Skin').deformedVertices[0].y, 10, 1e-8, 'Prefab A source Bone maps to instance A');
  near(engine.ecs.get('skin-b', 'Skin').deformedVertices[0].x, 10, 1e-8, 'Prefab B stays independent');
  near(engine.ecs.get('skin-b', 'Skin').deformedVertices[0].y, 0, 1e-8, 'Prefab B stays independent');

  // A marked owner whose instance is incomplete must never bind to a Scene
  // Entity merely because its Runtime id equals the Prefab source id.
  engine.createEntity({ id: 'rig', components: { Transform: {}, Skeleton: { rootBoneId: 'bone' } } });
  engine.createEntity({ id: 'bone', parentId: 'rig', components: { Transform: {}, Bone: { length: 10 } } });
  engine.createEntity({ id: 'isolated-rig', components: {
    Transform: {}, Skeleton: { rootBoneId: 'bone' }, PrefabInstance: marker('rig', 'missing-instance')
  } });
  engine.createEntity({ id: 'isolated-skin', components: {
    Transform: {},
    Skin: { skeletonRootId: 'rig', vertices: [{ x: 10, y: 0, weights: [{ boneId: 'bone', weight: 1 }] }] },
    PrefabInstance: marker('skin', 'missing-instance')
  } });
  engine.createEntity({ id: 'isolated-target', components: {
    Transform: { x: 0, y: 10 },
    IK: { skeletonRootId: 'rig', bones: ['bone'], iterations: 4 },
    PrefabInstance: marker('target', 'missing-instance')
  } });
  assert.deepStrictEqual(engine.skeleton.listBones('isolated-rig'), [], 'a marked Skeleton root cannot fall back to a same-id Scene Bone');
  engine.skeleton.rebind('isolated-skin');
  assert.strictEqual(engine.skeleton.bindings.get('isolated-skin').inverseBindMatrices.size, 0, 'Skin references cannot escape a marked Prefab group');
  assert.deepStrictEqual(engine.skeleton.solve('isolated-target').bones, [], 'IK references cannot escape a marked Prefab group');
  assert.strictEqual(engine.ecs.get('bone', 'Transform').rotation, 0, 'isolated IK must not mutate a same-id Scene Bone');

  const clip = {
    id: 'rig-pose', name: 'Rig Pose', fps: 30, frameCount: 1, loop: true,
    tracks: [
      { id: 'bone-pose', type: 'bone', targetEntityId: 'lower', keyframes: [{ id: 'bone-0', frame: 0, value: { x: 12, rotation: 45, scaleX: 1.5 } }] },
      { id: 'ik-pose', type: 'ik', targetEntityId: 'hand-target', keyframes: [{ id: 'ik-0', frame: 0, value: { x: 14, y: 6, mix: 0.25, enabled: false, iterations: 9, tolerance: 0.2, bendDirection: -1 } }] }
    ]
  };
  const animated = new AH2D.Engine({ physics: 'builtin' });
  animated.load(skeletonProject({ animations: [clip] }));
  animated.update(0);
  const lower = animated.ecs.get('lower', 'Transform');
  const target = animated.ecs.get('hand-target', 'Transform');
  const ik = animated.ecs.get('hand-target', 'IK');
  near(lower.x, 12); near(lower.rotation, 45); near(lower.scaleX, 1.5);
  near(target.x, 14); near(target.y, 6);
  assert.strictEqual(ik.mix, 0.25);
  assert.strictEqual(ik.enabled, false);
  assert.strictEqual(ik.iterations, 9);
  assert.strictEqual(ik.tolerance, 0.2);
  assert.strictEqual(ik.bendDirection, -1);

  const drivenClip = {
    id: 'driven-base', name: 'Driven Base', fps: 30, frameCount: 1, loop: true,
    tracks: [{ id: 'upper-base', type: 'bone', targetEntityId: 'upper', keyframes: [
      { id: 'upper-base-0', frame: 0, value: { rotation: 10 } }
    ] }]
  };
  const drivenDocument = skeletonProject({ animations: [drivenClip] });
  const drivenTarget = drivenDocument.scenes[0].objects.find(entity => entity.id === 'hand-target');
  drivenTarget.components.IK.mix = 0.5;
  drivenDocument.scene = JSON.parse(JSON.stringify(drivenDocument.scenes[0].objects));
  const driven = new AH2D.Engine({ physics: 'builtin' });
  driven.load(drivenDocument);
  driven.update(0);
  const firstDrivenPose = [
    driven.ecs.get('upper', 'Transform').rotation,
    driven.ecs.get('lower', 'Transform').rotation
  ];
  near(driven.skeleton.ikBasePose.get('upper').rotation, 10, 1e-10, 'Animation Bone Track becomes the stable pre-IK pose');
  driven.update(0);
  near(driven.ecs.get('upper', 'Transform').rotation, firstDrivenPose[0], 1e-10, 'Animation-driven base pose prevents mixed IK accumulation');
  near(driven.ecs.get('lower', 'Transform').rotation, firstDrivenPose[1], 1e-10, 'Animation-driven child solution remains stable');
};

const testPartialBoneAnimationKeepsStableIKBase = () => {
  const clip = {
    id: 'partial-base', name: 'Partial Base', fps: 30, frameCount: 1, loop: true,
    tracks: [
      { id: 'upper-x', type: 'bone', targetEntityId: 'upper', keyframes: [
        { id: 'upper-x-0', frame: 0, value: { x: 1 } }
      ] },
      { id: 'lower-x', type: 'position', targetEntityId: 'lower', keyframes: [
        { id: 'lower-x-0', frame: 0, value: { x: 11, y: 0 } }
      ] }
    ]
  };
  const document = skeletonProject({ animations: [clip] });
  const objects = document.scenes[0].objects;
  objects.find(entity => entity.id === 'upper').components.Transform.rotation = 10;
  objects.find(entity => entity.id === 'lower').components.Transform.rotation = -5;
  objects.find(entity => entity.id === 'hand-target').components.IK.mix = 0.5;
  document.scene = JSON.parse(JSON.stringify(objects));

  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load(document);
  engine.update(0);
  const first = [
    engine.ecs.get('upper', 'Transform').rotation,
    engine.ecs.get('lower', 'Transform').rotation
  ];
  near(engine.skeleton.ikBasePose.get('upper').rotation, 10, 1e-10, 'an x-only Bone Track preserves the authored base rotation');
  near(engine.skeleton.ikBasePose.get('lower').rotation, -5, 1e-10, 'a Position Track preserves the authored Bone base rotation');
  for (let index = 0; index < 4; index += 1) engine.update(0);
  near(engine.ecs.get('upper', 'Transform').rotation, first[0], 1e-10, 'partial Bone animation must not accumulate IK mix');
  near(engine.ecs.get('lower', 'Transform').rotation, first[1], 1e-10, 'partial Position animation must not accumulate IK mix');
};

const testIKReleaseAndReparentPreserveBasePose = () => {
  const clip = {
    id: 'release-base', name: 'Release Base', fps: 30, frameCount: 1, loop: true,
    tracks: [{ id: 'upper-x-only', type: 'bone', targetEntityId: 'upper', keyframes: [
      { id: 'upper-x-only-0', frame: 0, value: { x: 2 } }
    ] }]
  };
  const releaseDocument = skeletonProject({ animations: [clip] });
  releaseDocument.scenes[0].objects.find(entity => entity.id === 'hand-target').components.IK.mix = 0.5;
  releaseDocument.scene = JSON.parse(JSON.stringify(releaseDocument.scenes[0].objects));
  const release = new AH2D.Engine({ physics: 'builtin' });
  release.load(releaseDocument);
  release.update(0);
  assert.ok(Math.abs(release.ecs.get('lower', 'Transform').rotation) > 1, 'the IK constraint must establish a solved pose before removal');
  release.destroyEntity('hand-target');
  release.update(0);
  near(release.ecs.get('upper', 'Transform').x, 2, 1e-10, 'releasing an IK chain keeps the x-only Animation field');
  near(release.ecs.get('upper', 'Transform').rotation, 0, 1e-10, 'releasing an IK chain restores the authored upper rotation');
  near(release.ecs.get('lower', 'Transform').rotation, 0, 1e-10, 'releasing an IK chain restores every formerly constrained Bone');
  assert.strictEqual(release.skeleton.ikBasePose.size, 0, 'released IK base caches are discarded after restoration');

  const document = skeletonProject();
  document.scenes[0].objects.find(entity => entity.id === 'hand-target').components.IK.mix = 0.5;
  document.scene = JSON.parse(JSON.stringify(document.scenes[0].objects));
  const reparented = new AH2D.Engine({ physics: 'builtin' });
  reparented.load(document);
  reparented.update(0);
  const first = [
    reparented.ecs.get('upper', 'Transform').rotation,
    reparented.ecs.get('lower', 'Transform').rotation
  ];
  reparented.createEntity({ id: 'bone-parent', parentId: 'rig', components: { Transform: {} } });
  reparented.reparent('upper', 'bone-parent');
  reparented.update(0);
  near(reparented.ecs.get('upper', 'Transform').rotation, first[0], 1e-10, 'reparenting an actively constrained chain must not seed its base from the solved upper pose');
  near(reparented.ecs.get('lower', 'Transform').rotation, first[1], 1e-10, 'reparenting an actively constrained chain must not accumulate IK mix');

  const preserveWorld = new AH2D.Engine({ physics: 'builtin' });
  preserveWorld.load(document);
  preserveWorld.update(0);
  const preserved = [
    preserveWorld.ecs.get('upper', 'Transform').rotation,
    preserveWorld.ecs.get('lower', 'Transform').rotation
  ];
  preserveWorld.createEntity({ id: 'offset-parent', parentId: 'rig', components: { Transform: { x: 5 } } });
  preserveWorld.reparent('upper', 'offset-parent', { preserveWorld: true });
  near(preserveWorld.skeleton.ikBasePose.get('upper').x, -5, 1e-10, 'preserve-world reparent expresses the pre-IK base in the new parent space');
  preserveWorld.update(0);
  near(preserveWorld.ecs.get('upper', 'Transform').rotation, preserved[0], 1e-10, 'preserve-world reparent keeps the mixed upper solution stable');
  near(preserveWorld.ecs.get('lower', 'Transform').rotation, preserved[1], 1e-10, 'preserve-world reparent keeps the mixed lower solution stable');
};

const testSkeletalComponentGenerationInvalidation = () => {
  const skinEngine = new AH2D.Engine({ physics: 'builtin' });
  skinEngine.load(skeletonProject({ includeIK: false, includeSkin: true }));
  const originalBoneGeneration = skinEngine.ecs.componentGeneration('upper', 'Bone');
  const replacementBone = JSON.parse(JSON.stringify(skinEngine.ecs.get('upper', 'Bone')));
  skinEngine.ecs.get('upper', 'Transform').rotation = 90;
  skinEngine.transform.update();
  skinEngine.ecs.remove('upper', 'Bone');
  skinEngine.ecs.add('upper', 'Bone', replacementBone);
  const replacementBoneGeneration = skinEngine.ecs.componentGeneration('upper', 'Bone');
  assert.ok(replacementBoneGeneration > originalBoneGeneration, 'remove/add gives an identical Bone a new lifecycle generation');
  skinEngine.skeleton.deform('skin');
  assert.strictEqual(skinEngine.skeleton.bindings.get('skin').boneGenerations.get('upper'), replacementBoneGeneration);
  assert.deepStrictEqual(skinEngine.ecs.get('skin', 'Skin').deformedVertices[1], { x: 10, y: 0 }, 'a replacement Bone is captured at its own bind pose even when topology is identical');

  const oldSkinGeneration = skinEngine.ecs.componentGeneration('skin', 'Skin');
  const replacementSkin = JSON.parse(JSON.stringify(skinEngine.ecs.get('skin', 'Skin')));
  delete replacementSkin.deformedVertices;
  skinEngine.ecs.get('upper', 'Transform').rotation = 180;
  skinEngine.transform.update();
  skinEngine.ecs.remove('skin', 'Skin');
  skinEngine.ecs.add('skin', 'Skin', replacementSkin);
  const newSkinGeneration = skinEngine.ecs.componentGeneration('skin', 'Skin');
  assert.ok(newSkinGeneration > oldSkinGeneration, 'remove/add gives an identical Skin a new lifecycle generation');
  skinEngine.skeleton.deform('skin');
  assert.strictEqual(skinEngine.skeleton.bindings.get('skin').skinGeneration, newSkinGeneration);
  assert.deepStrictEqual(skinEngine.ecs.get('skin', 'Skin').deformedVertices[1], { x: 10, y: 0 }, 'a replacement Skin recaptures its complete bind space');

  const ikDocument = skeletonProject();
  ikDocument.scenes[0].objects.find(entity => entity.id === 'hand-target').components.IK.mix = 0.5;
  ikDocument.scene = JSON.parse(JSON.stringify(ikDocument.scenes[0].objects));
  const ikEngine = new AH2D.Engine({ physics: 'builtin' });
  ikEngine.load(ikDocument);
  ikEngine.update(0);
  const first = [ikEngine.ecs.get('upper', 'Transform').rotation, ikEngine.ecs.get('lower', 'Transform').rotation];
  const oldIKGeneration = ikEngine.ecs.componentGeneration('hand-target', 'IK');
  const replacementIK = JSON.parse(JSON.stringify(ikEngine.ecs.get('hand-target', 'IK')));
  ikEngine.ecs.remove('hand-target', 'IK');
  ikEngine.ecs.add('hand-target', 'IK', replacementIK);
  const newIKGeneration = ikEngine.ecs.componentGeneration('hand-target', 'IK');
  assert.ok(newIKGeneration > oldIKGeneration, 'remove/add gives an identical IK constraint a new lifecycle generation');
  ikEngine.update(0);
  assert.strictEqual(ikEngine.skeleton.ikConstraintState.get('hand-target').generation, newIKGeneration, 'the solver observes the replacement IK lifecycle');
  near(ikEngine.ecs.get('upper', 'Transform').rotation, first[0], 1e-10, 'replacing an identical IK component keeps the stable upper base');
  near(ikEngine.ecs.get('lower', 'Transform').rotation, first[1], 1e-10, 'replacing an identical IK component does not accumulate mix');
};

const testNestedSkeletonOwnershipBoundaries = () => {
  const objects = [
    { id: 'outer-rig', components: { Transform: {}, Skeleton: { rootBoneId: 'outer-bone' } } },
    { id: 'outer-bone', parentId: 'outer-rig', components: { Transform: {}, Bone: { length: 10 } } },
    { id: 'inner-rig', parentId: 'outer-bone', components: { Transform: { x: 10 }, Skeleton: { rootBoneId: 'inner-bone' } } },
    { id: 'inner-bone', parentId: 'inner-rig', components: { Transform: {}, Bone: { length: 6 } } },
    { id: 'outer-target', components: { Transform: { x: 0, y: 10 }, IK: { skeletonRootId: 'outer-rig', bones: ['outer-bone'], iterations: 8 } } },
    { id: 'inner-target', components: { Transform: { x: 14, y: 4 }, IK: { skeletonRootId: 'inner-rig', bones: ['inner-bone'], iterations: 8 } } },
    { id: 'outer-skin', components: { Transform: {}, Skin: {
      skeletonRootId: 'outer-rig', vertices: [{ x: 5, y: 0, weights: [{ boneId: 'outer-bone', weight: 1 }] }]
    } } },
    { id: 'inner-skin', components: { Transform: {}, Skin: {
      skeletonRootId: 'inner-rig', vertices: [{ x: 4, y: 0, weights: [{ boneId: 'inner-bone', weight: 1 }] }]
    } } }
  ];
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main', prefabs: [], animations: [],
    scenes: [{ id: 'main', name: 'Main', objects }], scene: JSON.parse(JSON.stringify(objects))
  });
  assert.deepStrictEqual(engine.skeleton.listBones('outer-rig'), ['outer-bone'], 'an outer Skeleton must stop at a nested Skeleton root');
  assert.deepStrictEqual(engine.skeleton.listBones('inner-rig'), ['inner-bone']);
  assert.deepStrictEqual(Object.keys(engine.skeleton.getPose('outer-rig')), ['outer-bone']);
  assert.deepStrictEqual(Object.keys(engine.skeleton.getPose('inner-bone')), ['inner-bone'], 'Bone ownership uses its nearest Skeleton ancestor');

  engine.ecs.get('outer-target', 'IK').bones.push('inner-bone');
  const outerResult = engine.skeleton.solve('outer-target');
  assert.deepStrictEqual(outerResult.bones, ['outer-bone'], 'Runtime IK rejects Bones owned by a nested Skeleton');

  const outerSkin = engine.ecs.get('outer-skin', 'Skin');
  outerSkin.vertices[0].weights = [{ boneId: 'inner-bone', weight: 1 }];
  engine.skeleton.rebind('outer-skin');
  assert.strictEqual(engine.skeleton.bindings.get('outer-skin').inverseBindMatrices.has('inner-bone'), false, 'Skin cannot bind through a nested Skeleton boundary');
  engine.ecs.get('inner-bone', 'Transform').rotation = 90;
  engine.transform.update();
  engine.skeleton.deform('outer-skin');
  assert.deepStrictEqual(outerSkin.deformedVertices[0], { x: 5, y: 0 }, 'foreign nested Bone weights fall back to the authored vertex');

  engine.createEntity({ id: 'implicit-rig', components: { Transform: {}, Skeleton: {} } });
  engine.createEntity({ id: 'implicit-nested', parentId: 'implicit-rig', components: { Transform: {}, Skeleton: {}, Bone: { length: 2 } } });
  engine.createEntity({ id: 'implicit-owned', parentId: 'implicit-rig', components: { Transform: {}, Bone: { length: 3 } } });
  assert.deepStrictEqual(engine.skeleton.listBones('implicit-rig'), ['implicit-owned'], 'implicit root selection skips a direct nested co-located Skeleton/Bone boundary');
};

const testCoLocatedSkeletonBoneOwnership = () => {
  const objects = [
    { id: 'outer-root', components: {
      Transform: {}, Skeleton: { rootBoneId: 'outer-root' }, Bone: { length: 10 }
    } },
    { id: 'inner-root', parentId: 'outer-root', components: {
      Transform: { x: 10 }, Skeleton: { rootBoneId: 'inner-root' }, Bone: { length: 6 }
    } },
    { id: 'outer-target', components: {
      Transform: { x: 0, y: 10 }, IK: { skeletonRootId: 'outer-root', bones: ['outer-root'], iterations: 20, tolerance: 0.001 }
    } },
    { id: 'inner-target', components: {
      Transform: { x: 0, y: 16 }, IK: { skeletonRootId: 'inner-root', bones: ['inner-root'], iterations: 20, tolerance: 0.001 }
    } },
    { id: 'outer-skin-colocated', components: { Transform: {}, Skin: {
      skeletonRootId: 'outer-root', vertices: [{ x: 10, y: 0, weights: [{ boneId: 'outer-root', weight: 1 }] }]
    } } },
    { id: 'inner-skin-colocated', components: { Transform: {}, Skin: {
      skeletonRootId: 'inner-root', vertices: [{ x: 16, y: 0, weights: [{ boneId: 'inner-root', weight: 1 }] }]
    } } }
  ];
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({
    format: 'AH2D', version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main', prefabs: [], animations: [],
    scenes: [{ id: 'main', name: 'Main', objects }], scene: JSON.parse(JSON.stringify(objects))
  });

  assert.deepStrictEqual(engine.skeleton.listBones('outer-root'), ['outer-root'], 'a co-located outer rig owns its own Bone but not a nested Skeleton root');
  assert.deepStrictEqual(engine.skeleton.listBones('inner-root'), ['inner-root'], 'a nested co-located rig owns its own Bone');
  assert.deepStrictEqual(Object.keys(engine.skeleton.getPose('inner-root')), ['inner-root']);
  assert.strictEqual(engine.skeleton.bindings.get('outer-skin-colocated').inverseBindMatrices.has('outer-root'), true);
  assert.strictEqual(engine.skeleton.bindings.get('inner-skin-colocated').inverseBindMatrices.has('inner-root'), true);

  const outerResult = engine.skeleton.solve('outer-target');
  assert.deepStrictEqual(outerResult.bones, ['outer-root']);
  assert.ok(outerResult.distance <= 0.01, 'IK must solve a co-located Skeleton/Bone root');
  const innerResult = engine.skeleton.solve('inner-target');
  assert.deepStrictEqual(innerResult.bones, ['inner-root']);
  engine.skeleton.deform();
  const outerVertex = engine.ecs.get('outer-skin-colocated', 'Skin').deformedVertices[0];
  const innerVertex = engine.ecs.get('inner-skin-colocated', 'Skin').deformedVertices[0];
  near(outerVertex.x, 0, 0.01, 'co-located outer Skin deformation x');
  near(outerVertex.y, 10, 0.01, 'co-located outer Skin deformation y');
  near(innerVertex.x, 0, 0.01, 'nested co-located Skin respects its own root x');
  near(innerVertex.y, 16, 0.01, 'nested co-located Skin respects its own root y');
};

const testPixiSkinnedMeshGeometry = async () => {
  const PIXI = createFakePixi();
  const texture = PIXI.Texture.from('/skin.png');
  const engine = new AH2D.Engine({
    physics: 'builtin', runtime: 'pixijs',
    runtimeOptions: { PIXI, loadAssets: false, textureResolver: () => texture }
  });
  engine.load(skeletonProject({ includeIK: false, includeSkin: true }));
  engine.start(fakeHost(), { restoreOnStop: false });
  await engine.runtime.ready;
  const record = engine.runtime.nodes.get('skin');
  assert.ok(record.visual instanceof PIXI.Mesh, 'Pixi v8 must render Skin output as a real Mesh');
  const initialGeometry = record.visual.geometry;
  assert.deepStrictEqual(Array.from(record.visual.geometry.positions), [0, 0, 10, 0, 10, 4, 0, 4]);
  assert.deepStrictEqual(Array.from(record.visual.geometry.uvs), [0, 0, 1, 0, 1, 1, 0, 1]);
  assert.deepStrictEqual(Array.from(record.visual.geometry.indices), [0, 1, 2, 0, 2, 3]);
  assert.strictEqual(record.visual.texture, texture);

  engine.ecs.get('upper', 'Transform').rotation = 90;
  engine.update(0);
  engine.runtime.render();
  const positions = Array.from(record.visual.geometry.positions);
  near(positions[2], 0, 1e-6, 'Pixi Mesh receives live LBS x');
  near(positions[3], 10, 1e-6, 'Pixi Mesh receives live LBS y');
  engine.ecs.get('skin', 'Skin').indices = [0, 1, 3, 1, 2, 3];
  engine.runtime.render();
  const replacementGeometry = record.visual.geometry;
  assert.notStrictEqual(replacementGeometry, initialGeometry, 'a changed Skin topology recreates its owned Pixi Geometry');
  assert.strictEqual(initialGeometry.destroyCount, 1, 'topology recreation destroys the superseded Geometry exactly once');
  engine.ecs.get('skin', 'Skin').indices = [0, 1, 99];
  engine.runtime.render();
  assert.strictEqual(record.visual, null, 'Pixi rejects an out-of-range topology instead of uploading a malformed index buffer');
  assert.strictEqual(replacementGeometry.destroyCount, 1, 'invalid topology removal destroys the active Geometry exactly once');

  engine.ecs.get('skin', 'Skin').indices = [0, 1, 2, 0, 2, 3];
  engine.runtime.render();
  const removedGeometry = record.visual.geometry;
  engine.ecs.remove('skin', 'Skin');
  engine.runtime.render();
  assert.strictEqual(record.visual, null);
  assert.strictEqual(removedGeometry.destroyCount, 1, 'removing Skin destroys its owned Geometry exactly once');
  engine.stop({ restore: false });
  assert.strictEqual(initialGeometry.destroyCount, 1);
  assert.strictEqual(replacementGeometry.destroyCount, 1);
  assert.strictEqual(removedGeometry.destroyCount, 1, 'adapter shutdown must not double-destroy released Geometry');
};

const testEditorRuntimeContract = () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'AH2DEdtior.html'), 'utf8');
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(inlineScripts.length > 0, 'editor must include its inline application script');
  inlineScripts.forEach((source, index) => assert.doesNotThrow(
    () => new vm.Script(source, { filename: `AH2DEdtior.inline-${index + 1}.js` }),
    `editor inline script ${index + 1} must be valid JavaScript`
  ));
  for (const id of ['runtimeSelect', 'editorPlay', 'editorPause', 'editorStop', 'runtimeBackend', 'addComponentBtn', 'sceneSelect', 'newSceneBtn', 'saveSceneBtn', 'sceneModal', 'postProcessBtn', 'postProcessPanel', 'postProcessList', 'postProcessReset']) {
    assert.ok(html.includes(`id="${id}"`), `editor runtime control #${id} is missing`);
  }
  for (const token of ['data-add-component="rigidbody"', 'data-add-component="box-collider"', 'data-add-component="circle-collider"', 'ah2dEngine.pause()', 'ah2dEngine.resume()', 'pullSceneTransformsFromEngine()', 'function switchScene(', 'function createScene(', 'function saveCurrentScene()', 'currentSceneId:state.currentSceneId', 'scenes,scene:', '...dataModelDescriptor', "componentSchemas.create('Rigidbody'", 'writeEditorComponent(', 'postProcess:cloneData(state.postProcess)', 'function applyScenePostProcess(', "requestedPhysics:'box2d'", 'physics:state.requestedPhysics', 'state.requestedPhysics=next.requestedPhysics', 'requireConfiguredPhysics()']) {
    assert.ok(html.includes(token), `editor integration token is missing: ${token}`);
  }
  const pixiScript = html.indexOf('./node_modules/pixi.js/dist/pixi.min.js'), pixiCspScript = html.indexOf('./node_modules/pixi.js/dist/packages/unsafe-eval.min.js'), planckScript = html.indexOf('./node_modules/planck/dist/planck.min.js'), dataModelScript = html.indexOf('./engine/AH2DDataModel.js'), engineScript = html.indexOf('./engine/AH2DEngine.js');
  assert.ok(pixiScript >= 0 && pixiCspScript > pixiScript && planckScript > pixiCspScript && dataModelScript > planckScript && engineScript > dataModelScript, 'Pixi, its CSP-safe polyfill, Planck, DataModel, and Engine must load in dependency order');
  assert.ok(!html.includes('fallbackPhysicsSubstep'), 'editor must not run a second competing physics solver');
  assert.ok(html.includes("renderer:state.runtime"), 'Universal JSON must persist the selected runtime');
};

const run = async () => {
  testSceneGraphAndRuntimes();
  testNestedSceneGraphTransforms();
  testReparentAndWorldTransformAPI();
  testSetWorldReplacesInheritedShear();
  testAtomicGraphGuards();
  testDestroyPolicies();
  testNestedPhysicsUsesWorldTransform();
  testNestedDynamicPhysicsMatrixSync();
  testNegativeScaleTransformRepresentation();
  testTransactionalEntityLifecycle();
  testDeepHierarchyTraversal();
  testTransformRemovalInvalidatesDescendants();
  testHugeTranslationShearGuard();
  testChildFirstNestedDynamicPhysics();
  testMirroredNestedColliderOffset();
  testTransactionalDestroyListenerFailures();
  testDestroyCommitSurvivesCollisionEndListener();
  testDestroyReentryGuards();
  testStaticColliderFollowsDynamicParentSameFrame();
  testTransformlessColliderInheritsAncestorWorld();
  assert.ok(AH2D.Matrix2D, 'Matrix2D must be public for renderer adapters');
  testUnifiedComponentSchemas();
  testEntityValidationBeforeRuntimeClone();
  testDistinctColliderComponents();
  testMultiSceneLoading();
  testAtomicLoadValidation();
  testLoadCommitSurvivesCollisionEndListener();
  testLoadCommitSurvivesEntityCreateListener();
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
  testRealPlanckForcesConfigurationAndLifecycle();
  testRealPlanckContactsTriggersFilteringAndMass();
  testDocumentPhysicsSelectionAndNativeSnapshot();
  testPublicPlayStopRestoresPhysicsBackendState();
  await testPixiV8AsyncMountAndNativeScene();
  await testPixiRuntimeMutationsAndAssetStaleness();
  testPixiSourceRectSubtextures();
  testPixiLiveChildrenSurviveParentDeletion();
  await testPixiStopWhileInitializationPending();
  await testMultiScenePlaySnapshotRestoreWithPixi();
  testFrameErrorStopsPixiRuntime();
  testPrefabAssetInstanceOverrideApplyRevertAndUnpack();
  testSkeletalPrefabUnpackRemapsRigAndAnimationReferences();
  testPrefabValidationIsAtomicAndSnapshotsRemainDefinitionFree();
  testPrefabArrayOverrideCoordinatesAndStalePromotion();
  testRealAnimationClipsAndTimelineSampling();
  testAnimationEventBoundariesAndPrefabTargetResolution();
  testSkeletonForwardKinematicsAndCCD();
  testLinearBlendSkinningAndSnapshotRestore();
  testSkeletonBindCacheSurvivesRuntimeLifecycle();
  testSkeletonPrefabReferencesAndAnimationTracks();
  testPartialBoneAnimationKeepsStableIKBase();
  testIKReleaseAndReparentPreserveBasePose();
  testSkeletalComponentGenerationInvalidation();
  testNestedSkeletonOwnershipBoundaries();
  testCoLocatedSkeletonBoneOwnership();
  await testPixiSkinnedMeshGeometry();
  testEditorRuntimeContract();
  console.log('AH2D Engine tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
