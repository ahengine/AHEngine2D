global.window = global;
global.devicePixelRatio = 1;
global.requestAnimationFrame = () => 101;
global.cancelAnimationFrame = () => {};

require('./AH2DEngine.js');

const assert = require('assert');

const near = (actual, expected, epsilon = 1e-8, message = '') => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${message} expected ${expected}, received ${actual}`);
};

const matrixNear = (actual, expected, message = 'matrix') => {
  assert.strictEqual(actual.length, 6, `${message} must contain six values`);
  expected.forEach((value, index) => near(actual[index], value, 1e-8, `${message}[${index}]`));
};

const multiply = (left, right) => [
  left[0] * right[0] + left[2] * right[1],
  left[1] * right[0] + left[3] * right[1],
  left[0] * right[2] + left[2] * right[3],
  left[1] * right[2] + left[3] * right[3],
  left[0] * right[4] + left[2] * right[5] + left[4],
  left[1] * right[4] + left[3] * right[5] + left[5]
];

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
};

class FakeCanvasContext2D {
  constructor() {
    this.calls = [];
    this.matrix = [1, 0, 0, 1, 0, 0];
    this.stack = [];
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.fillStyle = '#000000';
  }

  _record(type, args = []) {
    const call = {
      type,
      args: [...args],
      matrix: this.matrix.slice(),
      alpha: this.globalAlpha,
      composite: this.globalCompositeOperation,
      fillStyle: this.fillStyle
    };
    this.calls.push(call);
    return call;
  }

  setTransform(...values) {
    this.matrix = values.slice(0, 6);
    this._record('setTransform', values);
  }

  save() {
    this.stack.push({
      matrix: this.matrix.slice(),
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      fillStyle: this.fillStyle
    });
    this._record('save');
  }

  restore() {
    const state = this.stack.pop();
    if (state) {
      this.matrix = state.matrix;
      this.globalAlpha = state.globalAlpha;
      this.globalCompositeOperation = state.globalCompositeOperation;
      this.fillStyle = state.fillStyle;
    }
    this._record('restore');
  }

  translate(x, y) {
    this.matrix = multiply(this.matrix, [1, 0, 0, 1, x, y]);
    this._record('translate', [x, y]);
  }

  rotate(radians) {
    const cosine = Math.cos(radians), sine = Math.sin(radians);
    this.matrix = multiply(this.matrix, [cosine, sine, -sine, cosine, 0, 0]);
    this._record('rotate', [radians]);
  }

  scale(x, y) {
    this.matrix = multiply(this.matrix, [x, 0, 0, y, 0, 0]);
    this._record('scale', [x, y]);
  }

  clearRect(...args) { this._record('clearRect', args); }
  fillRect(...args) { this._record('fillRect', args); }
  drawImage(...args) { this._record('drawImage', args); }
  beginPath() { this._record('beginPath'); }
  closePath() { this._record('closePath'); }
  moveTo(...args) { this._record('moveTo', args); }
  lineTo(...args) { this._record('lineTo', args); }
  arc(...args) { this._record('arc', args); }
  fill() { this._record('fill'); }
}

class FakeCanvas {
  constructor(context = new FakeCanvasContext2D()) {
    this.nodeName = 'CANVAS';
    this.style = {};
    this.width = 1;
    this.height = 1;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.parentNode = null;
    this.context = context;
  }

  getContext(type) {
    assert.strictEqual(type, '2d', 'Custom Runtime must request a Canvas2D context');
    return this.context;
  }
}

class FakeCanvasHost {
  constructor(width = 400, height = 200) {
    this.clientWidth = width;
    this.clientHeight = height;
    this.children = [];
  }

  appendChild(child) {
    if (child.parentNode && child.parentNode !== this) child.parentNode.removeChild?.(child);
    if (!this.children.includes(child)) this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parentNode === this) child.parentNode = null;
    return child;
  }
}

const projectFixture = () => {
  const objects = [
    {
      id: 'camera',
      components: {
        Transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        Camera: { active: true, zoom: 1, viewportWidth: 200, viewportHeight: 100, clearColor: '#07111f' }
      }
    },
    {
      id: 'parent',
      components: {
        Transform: { x: 10, y: 20, rotation: 90, scaleX: 2, scaleY: 1 }
      }
    },
    {
      id: 'sprite',
      parentId: 'parent',
      components: {
        Transform: { x: 5, y: 6, rotation: 0, scaleX: 1, scaleY: 1 },
        Renderable: {
          assetId: 'hero-sheet',
          width: 40,
          height: 20,
          anchorX: 0.25,
          anchorY: 0.75,
          opacity: 0.75,
          layer: 2,
          sourceRect: { x: 32, y: 16, width: 16, height: 8 }
        }
      }
    },
    {
      id: 'implicit-size',
      components: {
        Transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
        Renderable: { assetId: 'hero-sheet', color: '#8080ff' }
      }
    },
    {
      id: 'hidden-parent',
      components: {
        Transform: { x: 20, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
        Hidden: {}
      }
    },
    {
      id: 'hidden-child',
      parentId: 'hidden-parent',
      components: {
        Transform: { x: 2, y: 3, rotation: 0, scaleX: 1, scaleY: 1 },
        Renderable: { width: 8, height: 6, color: '#ff00ff', layer: 1 }
      }
    },
    {
      id: 'spark-emitter',
      components: {
        Transform: { x: 30, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
        ParticleEmitter: { assetId: 'sparks', autoplay: false, playing: false, seed: 7 }
      }
    }
  ];

  return {
    format: 'AH2D',
    version: 4,
    dataModel: { id: 'ah2d.ecs', version: 1, componentSchemaVersion: 1 },
    currentSceneId: 'main',
    scenes: [{ id: 'main', name: 'Main', objects }],
    scene: JSON.parse(JSON.stringify(objects)),
    assets: [{ id: 'hero-sheet', futureAssetField: { keep: true } }],
    particles: [{
      id: 'sparks',
      name: 'Sparks',
      duration: 1,
      loop: true,
      maxParticles: 8,
      emission: { rate: 0, burst: 0 },
      lifetime: { min: 1, max: 1 },
      velocity: { speedMin: 0, speedMax: 0, angle: 0, spread: 0, gravityX: 0, gravityY: 0 },
      shape: { type: 'point', radius: 0, width: 0, height: 0 },
      appearance: {
        assetId: 'hero-sheet',
        color: '#ff0000',
        blend: 'additive',
        size: 6,
        baseScale: 1,
        baseOpacity: 1,
        baseHue: 0
      },
      curves: [],
      futureParticleField: { keep: true }
    }],
    postProcess: { enabled: true, effects: [] },
    futureProjectField: { keep: true }
  };
};

const testCustomCanvasUniversalScene = async () => {
  const host = new FakeCanvasHost();
  const context = new FakeCanvasContext2D();
  const canvas = new FakeCanvas(context);
  const tintContext = new FakeCanvasContext2D();
  const tintCanvas = new FakeCanvas(tintContext);
  const heroImage = { complete: true, naturalWidth: 256, naturalHeight: 128, width: 256, height: 128 };
  const engine = new AH2D.Engine({
    physics: 'builtin',
    runtime: 'custom',
    runtimeOptions: {
      canvasFactory: () => canvas,
      tintCanvasFactory: () => tintCanvas,
      imageResolver: renderable => renderable.assetId === 'hero-sheet' ? heroImage : null,
      viewport: { width: 200, height: 100, fit: 'contain' },
      resolution: 1
    }
  });
  const document = projectFixture();
  engine.load(document);

  const emitter = engine.ecs.get('spark-emitter', 'ParticleEmitter');
  emitter.particles = [{
    id: 'spark-emitter:0',
    x: 3,
    y: 4,
    rotation: 30,
    scale: 1.5,
    opacity: 0.4,
    hue: 120,
    color: '#ff0000',
    blend: 'additive'
  }];

  engine.start(host, { snapshot: false, restoreOnStop: false });
  await engine.runtime.ready;
  const runtime = engine.runtime;

  assert.strictEqual(runtime.name, 'custom');
  assert.strictEqual(runtime.backend, 'custom');
  assert.strictEqual(runtime.implementation, 'canvas2d');
  assert.strictEqual(runtime.native, true);
  assert.strictEqual(runtime.canvas, canvas);
  assert.strictEqual(runtime.context, context);
  assert.deepStrictEqual(host.children, [canvas], 'a container target must receive exactly one owned Canvas');
  assert.strictEqual(canvas.width, 400);
  assert.strictEqual(canvas.height, 200);

  assert.strictEqual(engine.document.version, 4, 'the Runtime must consume the Universal Project, not an ECS snapshot');
  assert.deepStrictEqual(engine.document.futureProjectField, { keep: true });
  assert.deepStrictEqual(engine.document.assets[0].futureAssetField, { keep: true });
  assert.deepStrictEqual(engine.document.particles[0].futureParticleField, { keep: true });

  const sprite = runtime.objects.get('sprite');
  matrixNear(sprite.world, [0, 2, -1, 0, 4, 30], 'nested world matrix');
  matrixNear(sprite.screen, [0, 4, -2, 0, 208, 160], 'camera-composed screen matrix');
  assert.strictEqual(sprite.parentId, 'parent');
  assert.strictEqual(sprite.visible, true);

  const croppedDraw = context.calls.find(call => call.type === 'drawImage' && call.args.length === 9 && call.args[0] === heroImage);
  assert.ok(croppedDraw, 'Renderable.sourceRect must use the cropped Canvas drawImage overload');
  assert.deepStrictEqual(croppedDraw.args.slice(1), [32, 16, 16, 8, -10, -15, 40, 20]);
  matrixNear(croppedDraw.matrix, sprite.screen, 'drawImage transform');
  near(croppedDraw.alpha, 0.75, 1e-8, 'Renderable opacity');
  const implicitSizeDraw = context.calls.find(call => call.type === 'drawImage' && call.args.length === 5 && call.args[0] === tintCanvas && call.composite === 'source-over');
  assert.ok(implicitSizeDraw, 'an Asset-backed Renderable without authored dimensions must still draw');
  assert.deepStrictEqual(implicitSizeDraw.args.slice(1), [-32, -32, 64, 64], 'Custom must share the stable 64x64 Universal fallback used by Pixi and Phaser');

  assert.strictEqual(runtime.objects.get('hidden-parent').visible, false);
  assert.strictEqual(runtime.objects.get('hidden-child').visible, false, 'Hidden visibility must propagate to descendants');
  assert.ok(!context.calls.some(call => call.type === 'fillRect' && call.fillStyle === '#ff00ff'), 'a hidden descendant must not be drawn');

  const particleDraw = context.calls.find(call => call.type === 'drawImage' && call.args[0] === tintCanvas && call.composite === 'lighter');
  assert.ok(particleDraw, 'textured live ParticleEmitter state must render through Canvas2D');
  near(particleDraw.matrix[4], 266, 1e-8, 'particle screen x');
  near(particleDraw.matrix[5], 148, 1e-8, 'particle screen y');
  near(particleDraw.alpha, 0.4, 1e-8, 'particle opacity');
  assert.ok(tintContext.calls.some(call => call.type === 'fillRect' && call.fillStyle === '#00ff00' && call.composite === 'multiply'), 'particle hue/tint must be composited into textured particles');
  assert.strictEqual(runtime.objects.get('spark-emitter').particleCount, 1);
  assert.strictEqual(runtime.viewport.cameraId, 'camera');
  assert.strictEqual(runtime.viewport.fit, 'contain');

  engine.ecs.remove('hidden-parent', 'Hidden');
  runtime.render(1);
  assert.strictEqual(runtime.objects.get('hidden-child').visible, true);
  assert.ok(context.calls.some(call => call.type === 'fillRect' && call.fillStyle === '#ff00ff'), 'removing Hidden must reconcile on the next render');

  engine.createEntity({
    id: 'runtime-shape',
    x: 12,
    y: 14,
    components: { Renderable: { width: 10, height: 12, color: '#00ff00', layer: 3 } }
  });
  runtime.render(1);
  assert.ok(runtime.objects.has('runtime-shape'), 'new ECS Entities must appear without remounting the Runtime');
  const worldBeforeReparent = runtime.objects.get('runtime-shape').world.slice();
  engine.reparent('runtime-shape', 'parent', { preserveWorld: true });
  runtime.render(1);
  assert.strictEqual(runtime.objects.get('runtime-shape').parentId, 'parent');
  matrixNear(runtime.objects.get('runtime-shape').world, worldBeforeReparent, 'preserve-world reparent');
  engine.destroyEntity('runtime-shape');
  runtime.render(1);
  assert.strictEqual(runtime.objects.has('runtime-shape'), false, 'deleted ECS Entities must be removed from Runtime records');

  runtime.resize(300, 150);
  assert.strictEqual(canvas.width, 300, 'explicit Custom Runtime width must override a nonzero host clientWidth');
  assert.strictEqual(canvas.height, 150, 'explicit Custom Runtime height must override a nonzero host clientHeight');

  engine.stop({ restore: false });
  assert.deepStrictEqual(host.children, [], 'Stop must remove an adapter-owned Canvas');
  assert.strictEqual(canvas.parentNode, null);
  assert.strictEqual(runtime.context, null);
  assert.strictEqual(runtime.objects.size, 0);
};

const testLegacyCustomHostHooks = async () => {
  const calls = [];
  let canvasFactoryCalls = 0;
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ format: 'AH2D', version: 4, scene: [{ id: 'legacy-host-object' }] });
  const target = { id: 'external-render-target' };
  const runtime = new AH2D.CustomRuntimeAdapter({
    canvasFactory() {
      canvasFactoryCalls += 1;
      return new FakeCanvas();
    },
    mount(receivedEngine, receivedTarget) {
      calls.push(['mount', receivedEngine, receivedTarget]);
    },
    render(receivedEngine, alpha) {
      calls.push(['render', receivedEngine, alpha]);
    },
    unmount() {
      calls.push(['unmount']);
    },
    destroy() {
      calls.push(['destroy']);
    }
  });

  runtime.mount(engine, target);
  await runtime.ready;
  assert.strictEqual(runtime.implementation, 'host');
  assert.strictEqual(runtime.native, true);
  assert.strictEqual(runtime.backend, 'custom');
  assert.strictEqual(canvasFactoryCalls, 0, 'a legacy render hook must remain an exclusive host-owned renderer');
  assert.deepStrictEqual(calls[0], ['mount', engine, target], 'legacy mount(engine, target) arguments must remain stable');

  runtime.render(0.25);
  assert.deepStrictEqual(calls[1], ['render', engine, 0.25], 'legacy render(engine, alpha) arguments must remain stable');
  assert.strictEqual(runtime.canvas, null);
  assert.strictEqual(runtime.context, null);

  runtime.destroy();
  assert.deepStrictEqual(calls.slice(2), [['unmount'], ['destroy']], 'destroy must detach an attached host exactly once');
  assert.strictEqual(runtime.engine, null);
  assert.strictEqual(runtime.target, null);
};

const testAsyncCustomHostFailure = async () => {
  const calls = [];
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ format: 'AH2D', version: 4, scene: [{ id: 'async-host-object' }] });
  const runtime = new AH2D.CustomRuntimeAdapter({
    mount() {
      calls.push('mount');
      return Promise.reject(new Error('host setup failed'));
    },
    render() { calls.push('render'); },
    unmount() { calls.push('unmount'); }
  });

  engine.useRuntime(runtime);
  engine.start({ id: 'async-target' }, { snapshot: false, restoreOnStop: false });
  await runtime.ready;
  assert.strictEqual(runtime.native, false);
  assert.strictEqual(runtime.backend, 'editor-bridge');
  assert.match(runtime.error.message, /host setup failed/);
  assert.deepStrictEqual(calls, ['mount', 'unmount'], 'an async host failure must not render and must detach once');

  engine.stop({ restore: false });
  assert.deepStrictEqual(calls, ['mount', 'unmount'], 'Stop after fallback must not call unmount a second time');
};

const testAsyncCustomCanvasReadinessAndCancellation = async () => {
  const setup = deferred();
  const context = new FakeCanvasContext2D();
  const canvas = new FakeCanvas(context);
  const engine = new AH2D.Engine({
    physics: 'builtin', runtime: 'custom',
    runtimeOptions: {
      canvasFactory: () => canvas,
      mount: () => setup.promise,
      builtin: true,
      resolution: 1
    }
  });
  engine.load({ format: 'AH2D', version: 4, scene: [{ id: 'shape', components: { Renderable: { width: 8, height: 8, color: '#ffffff' } } }] });
  engine.start(new FakeCanvasHost(), { snapshot: false, restoreOnStop: false, paused: true });
  assert.strictEqual(context.calls.some(call => call.type === 'clearRect'), false, 'built-in Custom rendering must wait for async mount setup');
  setup.resolve();
  await engine.runtime.ready;
  assert.strictEqual(context.calls.some(call => call.type === 'clearRect'), true, 'Custom must draw its first frame when async mount setup resolves');
  engine.stop({ restore: false });

  const never = deferred();
  const cancelledEngine = new AH2D.Engine({ physics: 'builtin' });
  cancelledEngine.load({ format: 'AH2D', version: 4, scene: [] });
  const cancelledRuntime = new AH2D.CustomRuntimeAdapter({ mount: () => never.promise, render() {} });
  cancelledEngine.useRuntime(cancelledRuntime);
  cancelledEngine.start({ id: 'host' }, { snapshot: false, restoreOnStop: false });
  const capturedReady = cancelledRuntime.ready;
  cancelledEngine.stop({ restore: false });
  await Promise.race([
    capturedReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled Custom ready did not settle')), 50))
  ]);
  never.reject(new Error('late rejection'));
  await Promise.resolve();
};

const testEngineStartFailureAndReadinessGate = () => {
  const engine = new AH2D.Engine({ physics: 'builtin' });
  engine.load({ format: 'AH2D', version: 4, scene: [] });
  const runtime = new AH2D.RuntimeAdapter('sync-fallback');
  runtime.mount = function mount(receivedEngine, target) {
    AH2D.RuntimeAdapter.prototype.mount.call(this, receivedEngine, target);
    this.native = false;
    this.backend = 'editor-bridge';
    this.error = new Error('sync fallback');
    receivedEngine.events.emit('runtime:fallback', { runtime: this, error: this.error, engine: receivedEngine });
    return this;
  };
  engine.useRuntime(runtime);
  let starts = 0;
  engine.events.on('runtime:start', () => { starts += 1; });
  engine.events.on('runtime:fallback', () => engine.pause());
  engine.start({ id: 'target' }, { snapshot: false, restoreOnStop: false });
  assert.strictEqual(engine.running, false, 'a synchronous fallback listener must be able to halt start before RAF scheduling');
  assert.strictEqual(engine.frameHandle, null);
  assert.strictEqual(starts, 0);

  const gated = new AH2D.Engine({ physics: 'builtin' });
  gated.load({ format: 'AH2D', version: 4, scene: [] });
  let pauses = 0;
  const gatedRuntime = new AH2D.RuntimeAdapter('gated');
  gatedRuntime.pause = () => { pauses += 1; return gatedRuntime; };
  gated.useRuntime(gatedRuntime);
  gated.start({ id: 'target' }, { snapshot: false, restoreOnStop: false, paused: true });
  assert.strictEqual(gated.running, false, 'paused start must not advance simulation before renderer readiness');
  assert.strictEqual(gated.frameHandle, null);
  assert.strictEqual(pauses, 1);
  gated.resume();
  assert.strictEqual(gated.running, true);
  assert.strictEqual(gated.frameHandle, 101);
  gated.stop({ restore: false });
};

const run = async () => {
  await testCustomCanvasUniversalScene();
  await testLegacyCustomHostHooks();
  await testAsyncCustomHostFailure();
  await testAsyncCustomCanvasReadinessAndCancellation();
  testEngineStartFailureAndReadinessGate();
  console.log('AH2D Runtime adapter tests passed');
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
