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
  const Texture = {
    WHITE: { id: 'white' },
    from(source) { return { id: String(source) }; }
  };
  const Assets = {
    get(key) { return assetCache?.get(key) || null; },
    load(source) {
      assetLoads.push(source);
      if (assetLoader) return assetLoader(source);
      return assetDeferred ? assetDeferred.promise : Promise.resolve({ id: String(source) });
    }
  };
  return { Application, Container, Sprite, Graphics, Matrix, Texture, Assets, applications, assetLoads };
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
  await testPixiV8AsyncMountAndNativeScene();
  await testPixiRuntimeMutationsAndAssetStaleness();
  testPixiLiveChildrenSurviveParentDeletion();
  await testPixiStopWhileInitializationPending();
  await testMultiScenePlaySnapshotRestoreWithPixi();
  testFrameErrorStopsPixiRuntime();
  testEditorRuntimeContract();
  console.log('AH2D Engine tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
