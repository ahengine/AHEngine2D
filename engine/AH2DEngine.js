(function (global) {
  'use strict';

  const VERSION = '0.3.0';
  const uid = () => `ah2d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  class EventBus {
    constructor() { this.listeners = new Map(); }
    on(type, fn) { const set = this.listeners.get(type) || new Set(); set.add(fn); this.listeners.set(type, set); return () => set.delete(fn); }
    emit(type, payload) { (this.listeners.get(type) || []).forEach(fn => fn(payload)); }
  }

  class ECS {
    constructor(events) { this.events = events; this.entities = new Set(); this.components = new Map(); }
    create(id = uid()) { this.entities.add(id); this.events.emit('entity:create', id); return id; }
    destroy(id) { this.entities.delete(id); this.components.forEach(store => store.delete(id)); this.events.emit('entity:destroy', id); }
    add(id, type, value = {}) { if (!this.entities.has(id)) this.create(id); const store = this.components.get(type) || new Map(); store.set(id, value); this.components.set(type, store); return value; }
    get(id, type) { return this.components.get(type)?.get(id); }
    has(id, type) { return this.components.get(type)?.has(id) || false; }
    remove(id, type) { this.components.get(type)?.delete(id); }
    query(...types) { return [...this.entities].filter(id => types.every(type => this.has(id, type))); }
    clear() { this.entities.clear(); this.components.clear(); }
  }

  class SceneGraph {
    constructor(events) { this.events = events; this.parent = new Map(); this.children = new Map(); }
    ensure(id) { if (!this.children.has(id)) this.children.set(id, new Set()); }
    attach(child, parent = null) {
      this.ensure(child);
      const old = this.parent.get(child);
      if (old) this.children.get(old)?.delete(child);
      if (parent) {
        if (child === parent || this.isDescendant(parent, child)) throw new Error('SceneGraph cycle detected');
        this.ensure(parent); this.parent.set(child, parent); this.children.get(parent).add(child);
      } else this.parent.delete(child);
      this.events.emit('graph:attach', { child, parent });
    }
    detach(child) { this.attach(child, null); }
    getParent(id) { return this.parent.get(id) || null; }
    getChildren(id) { return [...(this.children.get(id) || [])]; }
    roots(ids) { return [...ids].filter(id => !this.parent.has(id)); }
    isDescendant(id, possibleAncestor) { let p = this.parent.get(id); while (p) { if (p === possibleAncestor) return true; p = this.parent.get(p); } return false; }
    clear() { this.parent.clear(); this.children.clear(); }
  }

  const matrix = (x = 0, y = 0, rotation = 0, sx = 1, sy = 1) => {
    const r = rotation * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return [c * sx, s * sx, -s * sy, c * sy, x, y];
  };
  const multiply = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ];

  class TransformSystem {
    constructor(engine) { this.engine = engine; }
    update() {
      const { ecs, graph } = this.engine;
      const visit = (id, parentWorld = [1, 0, 0, 1, 0, 0]) => {
        const t = ecs.get(id, 'Transform');
        if (t) t.world = multiply(parentWorld, matrix(t.x, t.y, t.rotation, t.scaleX, t.scaleY));
        graph.getChildren(id).forEach(child => visit(child, t?.world || parentWorld));
      };
      graph.roots(ecs.entities).forEach(id => visit(id));
    }
  }

  class CameraSystem {
    constructor(engine) { this.engine = engine; this.active = null; }
    setActive(id) { this.active = id; }
    get view() { return this.active ? this.engine.ecs.get(this.active, 'Camera') : null; }
  }

  class LightingSystem {
    constructor(engine) { this.engine = engine; this.ambient = { color: '#ffffff', intensity: 0.35 }; }
    get lights() { return this.engine.ecs.query('Transform', 'Light').map(id => ({ id, transform: this.engine.ecs.get(id, 'Transform'), light: this.engine.ecs.get(id, 'Light') })); }
  }

  class ShadowSystem {
    constructor(engine) { this.engine = engine; this.enabled = true; }
    collect() { return this.enabled ? this.engine.ecs.query('Transform', 'ShadowCaster') : []; }
  }

  class AnimationSystem {
    constructor(engine) { this.engine = engine; this.time = 0; }
    update(dt) {
      this.time += dt;
      this.engine.ecs.query('Animation').forEach(id => {
        const a = this.engine.ecs.get(id, 'Animation');
        if (!a.playing || !a.duration) return;
        a.time = (a.time + dt * (a.speed || 1)) % a.duration;
      });
    }
  }

  const DEFAULT_POST_PROCESS_EFFECTS = Object.freeze([
    Object.freeze({ id: 'bloom', type: 'bloom', name: 'Bloom', enabled: false, intensity: 0.22, radius: 8, threshold: 0.72 }),
    Object.freeze({ id: 'vignette', type: 'vignette', name: 'Vignette', enabled: true, intensity: 0.24, softness: 0.68 }),
    Object.freeze({ id: 'color-adjust', type: 'colorAdjust', name: 'Color Adjust', enabled: true, brightness: 1, contrast: 1, saturation: 1, hue: 0 }),
    Object.freeze({ id: 'chromatic-aberration', type: 'chromaticAberration', name: 'Chromatic Aberration', enabled: false, amount: 3, intensity: 0.32 }),
    Object.freeze({ id: 'pixelate', type: 'pixelate', name: 'Pixelate', enabled: false, size: 4 }),
    Object.freeze({ id: 'crt', type: 'crt', name: 'CRT', enabled: false, scanlines: 0.18, noise: 0.04, curvature: 0.12 })
  ]);

  const createDefaultPostProcess = () => ({ enabled: true, effects: clone(DEFAULT_POST_PROCESS_EFFECTS) });

  class PostProcessSystem {
    constructor(engine) {
      this.engine = engine;
      this.enabled = true;
      this.effects = [];
      this.load();
    }
    load(source) {
      const config = source && typeof source === 'object' ? source : createDefaultPostProcess();
      this.enabled = config.enabled !== false;
      const effects = Array.isArray(config.effects) ? config.effects : DEFAULT_POST_PROCESS_EFFECTS;
      this.effects = clone(effects).filter(effect => effect && typeof effect === 'object').map((effect, index) => ({
        ...effect,
        id: String(effect.id || effect.type || `effect-${index + 1}`),
        type: String(effect.type || effect.id || 'custom'),
        name: String(effect.name || effect.type || effect.id || `Effect ${index + 1}`),
        enabled: effect.enabled !== false
      }));
      this.engine?.events.emit('postprocess:change', { postProcess: this, engine: this.engine });
      return this;
    }
    get(idOrType) { return this.effects.find(effect => effect.id === idOrType || effect.type === idOrType) || null; }
    configure(idOrType, values = {}) {
      const effect = this.get(idOrType);
      if (!effect || !values || typeof values !== 'object') return null;
      Object.assign(effect, clone(values));
      this.engine?.events.emit('postprocess:change', { effect, postProcess: this, engine: this.engine });
      return effect;
    }
    reset() { return this.load(createDefaultPostProcess()); }
    toJSON() { return { enabled: this.enabled, effects: clone(this.effects) }; }
    get active() { return this.enabled ? this.effects.filter(effect => effect.enabled !== false) : []; }
  }

  class TilemapSystem {
    constructor(engine) { this.engine = engine; }
    tileAt(id, x, y) { const m = this.engine.ecs.get(id, 'Tilemap'); return m?.tiles?.[y]?.[x] ?? null; }
    setTile(id, x, y, value) { const m = this.engine.ecs.get(id, 'Tilemap'); if (!m) return; m.tiles[y] ||= []; m.tiles[y][x] = value; }
  }

  const BODY_TYPES = Object.freeze({ STATIC: 'static', DYNAMIC: 'dynamic', KINEMATIC: 'kinematic' });
  const COLLIDER_SHAPES = Object.freeze({ BOX: 'box', CIRCLE: 'circle' });
  const DEG_TO_RAD = Math.PI / 180;
  const RAD_TO_DEG = 180 / Math.PI;
  const PHYSICS_EPSILON = 1e-8;
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const vector = (value, fallbackX = 0, fallbackY = 0) => {
    if (Array.isArray(value)) return { x: finite(value[0], fallbackX), y: finite(value[1], fallbackY) };
    if (value && typeof value === 'object') return { x: finite(value.x, fallbackX), y: finite(value.y, fallbackY) };
    return { x: fallbackX, y: fallbackY };
  };
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const rotate = (v, radians) => {
    const c = Math.cos(radians), s = Math.sin(radians);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  };
  const normalize = value => {
    const length = Math.hypot(value.x, value.y);
    return length > PHYSICS_EPSILON ? { x: value.x / length, y: value.y / length } : { x: 1, y: 0 };
  };
  const clone = value => {
    if (value == null) return value;
    if (typeof global.structuredClone === 'function') {
      try { return global.structuredClone(value); } catch (_) { /* JSON fallback below. */ }
    }
    return JSON.parse(JSON.stringify(value));
  };

  const normalizeBodyType = value => {
    const type = String(value || BODY_TYPES.DYNAMIC).toLowerCase();
    return type === BODY_TYPES.STATIC || type === BODY_TYPES.KINEMATIC ? type : BODY_TYPES.DYNAMIC;
  };

  const normalizeColliderList = (entityId, source, renderable = {}) => {
    if (!source) return [];
    let entries;
    if (Array.isArray(source)) entries = source;
    else if (Array.isArray(source.colliders)) entries = source.colliders;
    else if (Array.isArray(source.shapes)) entries = source.shapes;
    else entries = [source];
    return entries.filter(Boolean).map((raw, index) => {
      const size = raw.size || {};
      const offset = raw.offset || {};
      const shapeName = String(raw.shape || raw.type || (raw.radius != null ? 'circle' : 'box')).toLowerCase();
      const shape = shapeName === 'circle' || shapeName === 'sphere' ? COLLIDER_SHAPES.CIRCLE : COLLIDER_SHAPES.BOX;
      const width = Math.max(PHYSICS_EPSILON, Math.abs(finite(raw.width ?? raw.w ?? size.x, renderable.width || 32)));
      const height = Math.max(PHYSICS_EPSILON, Math.abs(finite(raw.height ?? raw.h ?? size.y, renderable.height || 32)));
      return {
        id: String(raw.id || `${entityId}:collider:${index}`),
        shape,
        width,
        height,
        radius: Math.max(PHYSICS_EPSILON, Math.abs(finite(raw.radius, Math.min(width, height) * 0.5))),
        offsetX: finite(raw.offsetX ?? offset.x, 0),
        offsetY: finite(raw.offsetY ?? offset.y, 0),
        rotation: finite(raw.rotation ?? raw.angle, 0),
        friction: Math.max(0, finite(raw.friction, 0.35)),
        restitution: clamp(finite(raw.restitution ?? raw.bounce, 0), 0, 1),
        density: Math.max(PHYSICS_EPSILON, finite(raw.density, 1)),
        isTrigger: Boolean(raw.isTrigger ?? raw.trigger ?? raw.sensor),
        enabled: raw.enabled !== false,
        categoryBits: finite(raw.categoryBits ?? raw.category, 1) | 0,
        maskBits: finite(raw.maskBits ?? raw.mask, 0xffff) | 0,
        groupIndex: finite(raw.groupIndex ?? raw.group, 0) | 0,
        source: raw
      };
    });
  };

  class PhysicsAdapter {
    constructor(options = {}) {
      this.name = 'builtin';
      this.backend = 'builtin';
      this.authoritative = true;
      this.bodies = new Map();
      this.contacts = new Map();
      this.engine = null;
      this.gravity = { x: 0, y: 9.8 };
      this.options = {};
      this.initialize(options);
    }
    initialize(options = {}) {
      this.options = { ...this.options, ...options };
      this.gravity = vector(options.gravity, this.gravity.x, this.gravity.y);
      this.pixelsPerMeter = Math.max(PHYSICS_EPSILON, finite(options.pixelsPerMeter, this.pixelsPerMeter || 100));
      this.maxStep = Math.max(1 / 1000, finite(options.maxStep, 1 / 60));
      this.velocityIterations = Math.max(1, Math.floor(finite(options.velocityIterations, 8)));
      this.positionCorrection = clamp(finite(options.positionCorrection, 0.8), 0, 1);
      this.positionSlop = Math.max(0, finite(options.positionSlop, 0.01));
      this.restitutionThreshold = Math.max(0, finite(options.restitutionThreshold, Math.hypot(this.gravity.x, this.gravity.y) * this.maxStep * 2));
      this.sleepLinearThreshold = Math.max(0, finite(options.sleepLinearThreshold, 0.05));
      this.sleepAngularThreshold = Math.max(0, finite(options.sleepAngularThreshold, 0.5));
      this.timeToSleep = Math.max(0, finite(options.timeToSleep, 0.5));
      this.initialized = true;
      return this;
    }
    setGravity(x, y) {
      this.gravity = typeof x === 'object' ? vector(x, this.gravity.x, this.gravity.y) : { x: finite(x, 0), y: finite(y, 9.8) };
      if (this.options.restitutionThreshold == null) this.restitutionThreshold = Math.hypot(this.gravity.x, this.gravity.y) * this.maxStep * 2;
      this.bodies.forEach(body => this.wake(body.entityId));
      return this;
    }
    createBody(entityId, descriptor = {}) {
      const transform = descriptor.transform || descriptor.Transform || descriptor;
      const rigidbody = descriptor.rigidbody || descriptor.Rigidbody || descriptor.body || descriptor;
      const renderable = descriptor.renderable || descriptor.Renderable || {};
      const body = {
        entityId,
        type: normalizeBodyType(rigidbody.type || rigidbody.bodyType),
        position: vector(transform.position, finite(transform.x, 0), finite(transform.y, 0)),
        rotation: finite(transform.rotation ?? transform.rot, 0),
        scaleX: finite(transform.scaleX ?? transform.sx, 1),
        scaleY: finite(transform.scaleY ?? transform.sy, 1),
        velocity: vector(rigidbody.velocity || rigidbody.linearVelocity, finite(rigidbody.velocityX, 0), finite(rigidbody.velocityY, 0)),
        angularVelocity: finite(rigidbody.angularVelocity, 0),
        force: { x: 0, y: 0 },
        torque: 0,
        mass: Math.max(PHYSICS_EPSILON, finite(rigidbody.mass, 1)),
        inverseMass: 0,
        inertia: 0,
        inverseInertia: 0,
        linearDamping: Math.max(0, finite(rigidbody.linearDamping ?? rigidbody.drag, 0)),
        angularDamping: Math.max(0, finite(rigidbody.angularDamping ?? rigidbody.angularDrag, 0)),
        gravityScale: finite(rigidbody.gravityScale, 1),
        fixedRotation: Boolean(rigidbody.fixedRotation),
        bullet: Boolean(rigidbody.bullet ?? rigidbody.continuous),
        useAutoMass: Boolean(rigidbody.useAutoMass ?? rigidbody.autoMass),
        allowSleep: rigidbody.allowSleep !== false,
        sleeping: Boolean(rigidbody.sleeping),
        sleepTime: 0,
        enabled: rigidbody.enabled !== false,
        colliders: normalizeColliderList(entityId, descriptor.collider || descriptor.Collider, renderable),
        managedByECS: Boolean(descriptor.managedByECS),
        userData: descriptor.userData ?? rigidbody.userData ?? null,
        _lastTransformWritten: null,
        _lastVelocityWritten: null,
        _lastAngularVelocityWritten: undefined,
        _lastSleepingWritten: undefined
      };
      this._updateMass(body);
      this.bodies.set(entityId, body);
      return body;
    }
    getBody(entityId) { return this.bodies.get(entityId) || null; }
    destroyBody(entityId) {
      if (!this.bodies.has(entityId)) return false;
      this._removeBodyContacts(entityId);
      this.bodies.delete(entityId);
      return true;
    }
    clear() {
      [...this.bodies.keys()].forEach(id => this.destroyBody(id));
      this.contacts.clear();
    }
    wake(entityId) {
      const body = typeof entityId === 'object' ? entityId : this.bodies.get(entityId);
      if (!body) return false;
      body.sleeping = false; body.sleepTime = 0;
      return true;
    }
    sleep(entityId) {
      const body = typeof entityId === 'object' ? entityId : this.bodies.get(entityId);
      if (!body || body.type !== BODY_TYPES.DYNAMIC || !body.allowSleep) return false;
      body.sleeping = true; body.sleepTime = this.timeToSleep; body.velocity.x = 0; body.velocity.y = 0; body.angularVelocity = 0;
      return true;
    }
    setTransform(entityId, x, y, rotation) {
      const body = this.bodies.get(entityId); if (!body) return false;
      if (typeof x === 'object') {
        const value = x; body.position = vector(value.position || value, body.position.x, body.position.y);
        if (value.rotation != null) body.rotation = finite(value.rotation, body.rotation);
      } else {
        body.position.x = finite(x, body.position.x); body.position.y = finite(y, body.position.y);
        if (rotation != null) body.rotation = finite(rotation, body.rotation);
      }
      this.wake(body); return true;
    }
    setVelocity(entityId, x, y) {
      const body = this.bodies.get(entityId); if (!body) return false;
      body.velocity = typeof x === 'object' ? vector(x, body.velocity.x, body.velocity.y) : { x: finite(x, 0), y: finite(y, 0) };
      this.wake(body); return true;
    }
    setAngularVelocity(entityId, degreesPerSecond) {
      const body = this.bodies.get(entityId); if (!body) return false;
      body.angularVelocity = finite(degreesPerSecond, 0); this.wake(body); return true;
    }
    applyForce(entityId, x, y) {
      const body = this.bodies.get(entityId); if (!body || body.type !== BODY_TYPES.DYNAMIC) return false;
      const force = typeof x === 'object' ? vector(x) : { x: finite(x, 0), y: finite(y, 0) };
      body.force.x += force.x; body.force.y += force.y; this.wake(body); return true;
    }
    applyTorque(entityId, torque) {
      const body = this.bodies.get(entityId); if (!body || body.type !== BODY_TYPES.DYNAMIC || body.fixedRotation) return false;
      body.torque += finite(torque, 0); this.wake(body); return true;
    }
    applyImpulse(entityId, x, y, point = null) {
      const body = this.bodies.get(entityId); if (!body || body.type !== BODY_TYPES.DYNAMIC) return false;
      const impulse = typeof x === 'object' ? vector(x) : { x: finite(x, 0), y: finite(y, 0) };
      body.velocity.x += impulse.x * body.inverseMass; body.velocity.y += impulse.y * body.inverseMass;
      if (point && body.inverseInertia > 0) {
        const p = vector(point); const arm = { x: p.x - body.position.x, y: p.y - body.position.y };
        body.angularVelocity += cross(arm, impulse) * body.inverseInertia * RAD_TO_DEG;
      }
      this.wake(body); return true;
    }
    snapshot() {
      return {
        gravity: { ...this.gravity },
        bodies: [...this.bodies].map(([id, body]) => [id, {
          position: { ...body.position }, rotation: body.rotation, velocity: { ...body.velocity },
          angularVelocity: body.angularVelocity, sleeping: body.sleeping, sleepTime: body.sleepTime
        }])
      };
    }
    restore(snapshot) {
      if (!snapshot) return false;
      if (snapshot.gravity) this.setGravity(snapshot.gravity);
      (snapshot.bodies || []).forEach(([id, value]) => {
        const body = this.bodies.get(id); if (!body) return;
        body.position = vector(value.position, body.position.x, body.position.y);
        body.rotation = finite(value.rotation, body.rotation);
        body.velocity = vector(value.velocity);
        body.angularVelocity = finite(value.angularVelocity, 0);
        body.sleeping = Boolean(value.sleeping); body.sleepTime = finite(value.sleepTime, 0);
      });
      return true;
    }
    step(dt, engine = this.engine) {
      dt = clamp(finite(dt, 0), 0, 0.25);
      if (dt <= 0) return;
      let count = Math.max(1, Math.ceil(dt / this.maxStep));
      this.bodies.forEach(body => {
        if (!body.bullet || body.type !== BODY_TYPES.DYNAMIC || !body.enabled) return;
        const minimumExtent = body.colliders.reduce((minimum, collider) => {
          if (!collider.enabled) return minimum;
          const extent = collider.shape === COLLIDER_SHAPES.CIRCLE
            ? collider.radius * Math.max(Math.abs(body.scaleX), Math.abs(body.scaleY))
            : Math.min(collider.width * Math.abs(body.scaleX), collider.height * Math.abs(body.scaleY)) * 0.5;
          return Math.min(minimum, extent);
        }, Infinity);
        if (!Number.isFinite(minimumExtent)) return;
        const travel = Math.hypot(body.velocity.x, body.velocity.y) * dt;
        count = Math.max(count, Math.ceil(travel / Math.max(1, minimumExtent * 0.5)));
      });
      count = Math.min(Math.max(1, Math.floor(finite(this.options.maxSubSteps, 32))), count);
      const stepTime = dt / count;
      let finalContacts = new Map();
      for (let i = 0; i < count; i += 1) {
        this._integrate(stepTime);
        finalContacts = this._detectContacts();
        this._solveContacts(finalContacts);
      }
      this.bodies.forEach(body => { body.force.x = 0; body.force.y = 0; body.torque = 0; });
      this._updateSleeping(dt, finalContacts);
      this._emitContactChanges(finalContacts, engine);
    }
    sync(engine, phase = 'both') {
      if (!engine) return;
      this.engine = engine;
      if (phase !== 'after') this._syncFromECS(engine);
      if (phase !== 'before') this._syncToECS(engine);
    }
    _syncFromECS(engine) {
      const eligible = new Set();
      engine.ecs.entities.forEach(entityId => {
        const rigidbody = engine.ecs.get(entityId, 'Rigidbody') || engine.ecs.get(entityId, 'RigidBody');
        const generic = engine.ecs.get(entityId, 'Collider');
        const box = engine.ecs.get(entityId, 'BoxCollider2D') || engine.ecs.get(entityId, 'BoxCollider');
        const circle = engine.ecs.get(entityId, 'CircleCollider2D') || engine.ecs.get(entityId, 'CircleCollider');
        if (!rigidbody && !generic && !box && !circle) return;
        eligible.add(entityId);
        const transform = engine.ecs.get(entityId, 'Transform') || {};
        const renderable = engine.ecs.get(entityId, 'Renderable') || {};
        const colliderSources = [];
        const append = source => {
          if (!source) return;
          if (Array.isArray(source)) colliderSources.push(...source);
          else if (Array.isArray(source.colliders)) colliderSources.push(...source.colliders);
          else if (Array.isArray(source.shapes)) colliderSources.push(...source.shapes);
          else colliderSources.push(source);
        };
        append(generic); if (box) append({ ...box, shape: 'box' }); if (circle) append({ ...circle, shape: 'circle' });
        let body = this.bodies.get(entityId);
        const isNew = !body;
        if (!body) body = this.createBody(entityId, { transform, rigidbody: rigidbody || { type: 'static' }, collider: colliderSources, renderable, managedByECS: true });
        body.managedByECS = true;
        const local = {
          x: finite(transform.x, 0), y: finite(transform.y, 0), rotation: finite(transform.rotation, 0),
          scaleX: finite(transform.scaleX, 1), scaleY: finite(transform.scaleY, 1)
        };
        if (isNew || !body._lastTransformWritten || Object.keys(local).some(key => Math.abs(local[key] - body._lastTransformWritten[key]) > 1e-7)) {
          const world = transform.world;
          body.position.x = Array.isArray(world) ? finite(world[4], local.x) : local.x;
          body.position.y = Array.isArray(world) ? finite(world[5], local.y) : local.y;
          body.rotation = Array.isArray(world) ? Math.atan2(world[1], world[0]) * RAD_TO_DEG : local.rotation;
          body.scaleX = Array.isArray(world) ? Math.hypot(world[0], world[1]) : local.scaleX;
          body.scaleY = Array.isArray(world) ? Math.hypot(world[2], world[3]) : local.scaleY;
          body._lastTransformWritten = local;
          this.wake(body);
        }
        const source = rigidbody || { type: 'static' };
        body.type = normalizeBodyType(source.type || source.bodyType || (rigidbody ? 'dynamic' : 'static'));
        body.mass = Math.max(PHYSICS_EPSILON, finite(source.mass, body.mass || 1));
        body.linearDamping = Math.max(0, finite(source.linearDamping ?? source.drag, body.linearDamping));
        body.angularDamping = Math.max(0, finite(source.angularDamping ?? source.angularDrag, body.angularDamping));
        body.gravityScale = finite(source.gravityScale, body.gravityScale);
        body.fixedRotation = Boolean(source.fixedRotation);
        body.bullet = Boolean(source.bullet ?? source.continuous);
        body.useAutoMass = Boolean(source.useAutoMass ?? source.autoMass);
        body.allowSleep = source.allowSleep !== false;
        body.enabled = source.enabled !== false;
        const incomingVelocity = vector(source.velocity || source.linearVelocity, finite(source.velocityX, body.velocity.x), finite(source.velocityY, body.velocity.y));
        if (isNew || !body._lastVelocityWritten || Math.abs(incomingVelocity.x - body._lastVelocityWritten.x) > 1e-7 || Math.abs(incomingVelocity.y - body._lastVelocityWritten.y) > 1e-7) {
          body.velocity = incomingVelocity; this.wake(body);
        }
        const incomingAngularVelocity = finite(source.angularVelocity, body.angularVelocity);
        if (isNew || body._lastAngularVelocityWritten === undefined || Math.abs(incomingAngularVelocity - body._lastAngularVelocityWritten) > 1e-7) {
          body.angularVelocity = incomingAngularVelocity; this.wake(body);
        }
        if (source.sleeping !== undefined && (isNew || source.sleeping !== body._lastSleepingWritten)) {
          if (source.sleeping) this.sleep(body); else this.wake(body);
        }
        body.colliders = normalizeColliderList(entityId, colliderSources, renderable);
        this._updateMass(body);
      });
      [...this.bodies].forEach(([id, body]) => { if (body.managedByECS && !eligible.has(id)) this.destroyBody(id); });
    }
    _syncToECS(engine) {
      this.bodies.forEach((body, entityId) => {
        if (!body.managedByECS || !engine.ecs.entities.has(entityId)) return;
        const transform = engine.ecs.get(entityId, 'Transform');
        if (transform && body.type !== BODY_TYPES.STATIC) {
          const parentId = engine.graph.getParent(entityId);
          const parentWorld = parentId ? engine.ecs.get(parentId, 'Transform')?.world : null;
          if (parentWorld) {
            const determinant = parentWorld[0] * parentWorld[3] - parentWorld[1] * parentWorld[2];
            if (Math.abs(determinant) > PHYSICS_EPSILON) {
              const dx = body.position.x - parentWorld[4], dy = body.position.y - parentWorld[5];
              transform.x = (parentWorld[3] * dx - parentWorld[2] * dy) / determinant;
              transform.y = (-parentWorld[1] * dx + parentWorld[0] * dy) / determinant;
            } else { transform.x = body.position.x; transform.y = body.position.y; }
            transform.rotation = body.rotation - Math.atan2(parentWorld[1], parentWorld[0]) * RAD_TO_DEG;
          } else {
            transform.x = body.position.x; transform.y = body.position.y; transform.rotation = body.rotation;
          }
        }
        if (transform) body._lastTransformWritten = {
          x: finite(transform.x, 0), y: finite(transform.y, 0), rotation: finite(transform.rotation, 0),
          scaleX: finite(transform.scaleX, 1), scaleY: finite(transform.scaleY, 1)
        };
        const rigidbody = engine.ecs.get(entityId, 'Rigidbody') || engine.ecs.get(entityId, 'RigidBody');
        if (rigidbody) {
          rigidbody.type = body.type;
          rigidbody.velocity = { ...body.velocity };
          rigidbody.velocityX = body.velocity.x;
          rigidbody.velocityY = body.velocity.y;
          rigidbody.angularVelocity = body.angularVelocity;
          rigidbody.mass = body.mass;
          rigidbody.inverseMass = body.inverseMass;
          rigidbody.gravityScale = body.gravityScale;
          rigidbody.linearDamping = body.linearDamping;
          rigidbody.angularDamping = body.angularDamping;
          rigidbody.fixedRotation = body.fixedRotation;
          rigidbody.bullet = body.bullet;
          rigidbody.useAutoMass = body.useAutoMass;
          rigidbody.sleeping = body.sleeping;
          body._lastVelocityWritten = { ...body.velocity };
          body._lastAngularVelocityWritten = body.angularVelocity;
          body._lastSleepingWritten = body.sleeping;
        }
      });
    }
    _updateMass(body) {
      if (body.useAutoMass) {
        const calculatedMass = body.colliders.reduce((total, collider) => {
          if (!collider.enabled || collider.isTrigger) return total;
          const area = collider.shape === COLLIDER_SHAPES.CIRCLE
            ? Math.PI * Math.pow(collider.radius * Math.max(Math.abs(body.scaleX), Math.abs(body.scaleY)), 2)
            : collider.width * Math.abs(body.scaleX) * collider.height * Math.abs(body.scaleY);
          return total + area * collider.density;
        }, 0);
        if (calculatedMass > PHYSICS_EPSILON) body.mass = calculatedMass / (this.pixelsPerMeter * this.pixelsPerMeter);
      }
      body.inverseMass = body.type === BODY_TYPES.DYNAMIC ? 1 / Math.max(PHYSICS_EPSILON, body.mass) : 0;
      let inertia = 0;
      const colliders = body.colliders.filter(collider => collider.enabled && !collider.isTrigger);
      const weight = colliders.length ? body.mass / colliders.length : body.mass;
      colliders.forEach(collider => {
        if (collider.shape === COLLIDER_SHAPES.CIRCLE) {
          const radius = collider.radius * Math.max(Math.abs(body.scaleX), Math.abs(body.scaleY));
          inertia += 0.5 * weight * radius * radius;
        } else {
          const width = collider.width * Math.abs(body.scaleX), height = collider.height * Math.abs(body.scaleY);
          inertia += weight * (width * width + height * height) / 12;
        }
      });
      body.inertia = inertia || body.mass;
      body.inverseInertia = body.type === BODY_TYPES.DYNAMIC && !body.fixedRotation ? 1 / Math.max(PHYSICS_EPSILON, body.inertia) : 0;
      if (body.fixedRotation) body.angularVelocity = 0;
    }
    _integrate(dt) {
      this.bodies.forEach(body => {
        if (!body.enabled || body.type === BODY_TYPES.STATIC || body.sleeping) return;
        if (body.type === BODY_TYPES.DYNAMIC) {
          body.velocity.x += (this.gravity.x * body.gravityScale + body.force.x * body.inverseMass) * dt;
          body.velocity.y += (this.gravity.y * body.gravityScale + body.force.y * body.inverseMass) * dt;
          if (!body.fixedRotation) body.angularVelocity += body.torque * body.inverseInertia * RAD_TO_DEG * dt;
        }
        const linearDecay = 1 / (1 + body.linearDamping * dt);
        const angularDecay = 1 / (1 + body.angularDamping * dt);
        body.velocity.x *= linearDecay; body.velocity.y *= linearDecay;
        if (!body.fixedRotation) body.angularVelocity *= angularDecay; else body.angularVelocity = 0;
        body.position.x += body.velocity.x * dt; body.position.y += body.velocity.y * dt;
        if (!body.fixedRotation) body.rotation += body.angularVelocity * dt;
      });
    }
    _worldShape(body, collider) {
      const angle = body.rotation * DEG_TO_RAD;
      const offset = rotate({ x: collider.offsetX * body.scaleX, y: collider.offsetY * body.scaleY }, angle);
      const center = { x: body.position.x + offset.x, y: body.position.y + offset.y };
      if (collider.shape === COLLIDER_SHAPES.CIRCLE) return {
        type: 'circle', center, radius: collider.radius * Math.max(Math.abs(body.scaleX), Math.abs(body.scaleY))
      };
      const boxAngle = angle + collider.rotation * DEG_TO_RAD;
      return {
        type: 'box', center, halfX: collider.width * Math.abs(body.scaleX) * 0.5,
        halfY: collider.height * Math.abs(body.scaleY) * 0.5, angle: boxAngle,
        axisX: { x: Math.cos(boxAngle), y: Math.sin(boxAngle) },
        axisY: { x: -Math.sin(boxAngle), y: Math.cos(boxAngle) }
      };
    }
    _canCollide(a, b) {
      if (!a.enabled || !b.enabled) return false;
      if (a.groupIndex && a.groupIndex === b.groupIndex) return a.groupIndex > 0;
      return Boolean((a.maskBits & b.categoryBits) && (b.maskBits & a.categoryBits));
    }
    _detectContacts() {
      const contacts = new Map();
      const bodies = [...this.bodies.values()].filter(body => body.enabled && body.colliders.some(collider => collider.enabled));
      for (let i = 0; i < bodies.length; i += 1) for (let j = i + 1; j < bodies.length; j += 1) {
        const bodyA = bodies[i], bodyB = bodies[j];
        bodyA.colliders.forEach(colliderA => bodyB.colliders.forEach(colliderB => {
          if (!this._canCollide(colliderA, colliderB)) return;
          const shapeA = this._worldShape(bodyA, colliderA), shapeB = this._worldShape(bodyB, colliderB);
          const manifold = this._manifold(shapeA, shapeB);
          if (!manifold) return;
          const key = `${colliderA.id}|${colliderB.id}`;
          contacts.set(key, {
            key, bodyA, bodyB, colliderA, colliderB, shapeA, shapeB,
            normal: manifold.normal, penetration: manifold.penetration, point: manifold.point,
            trigger: colliderA.isTrigger || colliderB.isTrigger
          });
        }));
      }
      return contacts;
    }
    _manifold(a, b) {
      if (a.type === 'circle' && b.type === 'circle') return this._circleCircle(a, b);
      if (a.type === 'box' && b.type === 'box') return this._boxBox(a, b);
      if (a.type === 'circle') return this._circleBox(a, b);
      const result = this._circleBox(b, a);
      return result ? { ...result, normal: { x: -result.normal.x, y: -result.normal.y } } : null;
    }
    _circleCircle(a, b) {
      const delta = { x: b.center.x - a.center.x, y: b.center.y - a.center.y };
      const radius = a.radius + b.radius, distanceSquared = dot(delta, delta);
      if (distanceSquared > radius * radius) return null;
      const distance = Math.sqrt(distanceSquared);
      const normal = distance > PHYSICS_EPSILON ? { x: delta.x / distance, y: delta.y / distance } : { x: 1, y: 0 };
      return {
        normal, penetration: radius - distance,
        point: { x: a.center.x + normal.x * (a.radius - (radius - distance) * 0.5), y: a.center.y + normal.y * (a.radius - (radius - distance) * 0.5) }
      };
    }
    _boxBox(a, b) {
      const delta = { x: b.center.x - a.center.x, y: b.center.y - a.center.y };
      const axes = [a.axisX, a.axisY, b.axisX, b.axisY];
      let penetration = Infinity, normal = null;
      for (const axis of axes) {
        const radiusA = a.halfX * Math.abs(dot(a.axisX, axis)) + a.halfY * Math.abs(dot(a.axisY, axis));
        const radiusB = b.halfX * Math.abs(dot(b.axisX, axis)) + b.halfY * Math.abs(dot(b.axisY, axis));
        const distance = dot(delta, axis), overlap = radiusA + radiusB - Math.abs(distance);
        if (overlap < 0) return null;
        if (overlap < penetration) {
          penetration = overlap;
          const sign = distance < 0 ? -1 : 1;
          normal = { x: axis.x * sign, y: axis.y * sign };
        }
      }
      normal ||= { x: 1, y: 0 };
      const tangent = { x: -normal.y, y: normal.x };
      const projectedRadius = (box, axis) => box.halfX * Math.abs(dot(box.axisX, axis)) + box.halfY * Math.abs(dot(box.axisY, axis));
      const tangentA = dot(a.center, tangent), tangentB = dot(b.center, tangent);
      const tangentRadiusA = projectedRadius(a, tangent), tangentRadiusB = projectedRadius(b, tangent);
      const tangentMin = Math.max(tangentA - tangentRadiusA, tangentB - tangentRadiusB);
      const tangentMax = Math.min(tangentA + tangentRadiusA, tangentB + tangentRadiusB);
      const tangentCoordinate = (tangentMin + tangentMax) * 0.5;
      const surfaceA = dot(a.center, normal) + projectedRadius(a, normal);
      const surfaceB = dot(b.center, normal) - projectedRadius(b, normal);
      const normalCoordinate = (surfaceA + surfaceB) * 0.5;
      return {
        normal, penetration,
        point: {
          x: normal.x * normalCoordinate + tangent.x * tangentCoordinate,
          y: normal.y * normalCoordinate + tangent.y * tangentCoordinate
        }
      };
    }
    _circleBox(circle, box) {
      const relative = { x: circle.center.x - box.center.x, y: circle.center.y - box.center.y };
      const local = { x: dot(relative, box.axisX), y: dot(relative, box.axisY) };
      const closest = { x: clamp(local.x, -box.halfX, box.halfX), y: clamp(local.y, -box.halfY, box.halfY) };
      let delta = { x: closest.x - local.x, y: closest.y - local.y };
      let distance = Math.hypot(delta.x, delta.y), penetration, normalLocal;
      if (distance > PHYSICS_EPSILON) {
        if (distance > circle.radius) return null;
        normalLocal = { x: delta.x / distance, y: delta.y / distance };
        penetration = circle.radius - distance;
      } else {
        const distanceX = box.halfX - Math.abs(local.x), distanceY = box.halfY - Math.abs(local.y);
        if (distanceX < distanceY) normalLocal = { x: local.x >= 0 ? -1 : 1, y: 0 };
        else normalLocal = { x: 0, y: local.y >= 0 ? -1 : 1 };
        penetration = circle.radius + Math.min(distanceX, distanceY);
        distance = 0;
      }
      const normal = {
        x: box.axisX.x * normalLocal.x + box.axisY.x * normalLocal.y,
        y: box.axisX.y * normalLocal.x + box.axisY.y * normalLocal.y
      };
      const closestWorld = {
        x: box.center.x + box.axisX.x * closest.x + box.axisY.x * closest.y,
        y: box.center.y + box.axisX.y * closest.x + box.axisY.y * closest.y
      };
      return { normal: normalize(normal), penetration, point: closestWorld };
    }
    _solveContacts(contacts) {
      const solid = [...contacts.values()].filter(contact => !contact.trigger);
      solid.forEach(contact => this._correctPosition(contact));
      for (let i = 0; i < this.velocityIterations; i += 1) solid.forEach(contact => this._resolveVelocity(contact));
    }
    _correctPosition(contact) {
      const { bodyA, bodyB, normal } = contact;
      const total = bodyA.inverseMass + bodyB.inverseMass;
      if (total <= PHYSICS_EPSILON) return;
      const magnitude = Math.max(contact.penetration - this.positionSlop, 0) * this.positionCorrection / total;
      bodyA.position.x -= normal.x * magnitude * bodyA.inverseMass;
      bodyA.position.y -= normal.y * magnitude * bodyA.inverseMass;
      bodyB.position.x += normal.x * magnitude * bodyB.inverseMass;
      bodyB.position.y += normal.y * magnitude * bodyB.inverseMass;
    }
    _velocityAt(body, arm) {
      const angular = body.angularVelocity * DEG_TO_RAD;
      return { x: body.velocity.x - angular * arm.y, y: body.velocity.y + angular * arm.x };
    }
    _resolveVelocity(contact) {
      const { bodyA, bodyB, colliderA, colliderB, normal, point } = contact;
      const armA = { x: point.x - bodyA.position.x, y: point.y - bodyA.position.y };
      const armB = { x: point.x - bodyB.position.x, y: point.y - bodyB.position.y };
      let relative = {
        x: this._velocityAt(bodyB, armB).x - this._velocityAt(bodyA, armA).x,
        y: this._velocityAt(bodyB, armB).y - this._velocityAt(bodyA, armA).y
      };
      const normalSpeed = dot(relative, normal);
      if (normalSpeed > 0) return;
      const armNormalA = cross(armA, normal), armNormalB = cross(armB, normal);
      const denominator = bodyA.inverseMass + bodyB.inverseMass + armNormalA * armNormalA * bodyA.inverseInertia + armNormalB * armNormalB * bodyB.inverseInertia;
      if (denominator <= PHYSICS_EPSILON) return;
      const restitution = -normalSpeed >= this.restitutionThreshold ? Math.max(colliderA.restitution, colliderB.restitution) : 0;
      const impulseMagnitude = -(1 + restitution) * normalSpeed / denominator;
      const impulse = { x: normal.x * impulseMagnitude, y: normal.y * impulseMagnitude };
      this._applyPairImpulse(bodyA, bodyB, armA, armB, impulse);
      relative = {
        x: this._velocityAt(bodyB, armB).x - this._velocityAt(bodyA, armA).x,
        y: this._velocityAt(bodyB, armB).y - this._velocityAt(bodyA, armA).y
      };
      const tangentRaw = { x: relative.x - normal.x * dot(relative, normal), y: relative.y - normal.y * dot(relative, normal) };
      const tangentLength = Math.hypot(tangentRaw.x, tangentRaw.y);
      if (tangentLength <= PHYSICS_EPSILON) return;
      const tangent = { x: tangentRaw.x / tangentLength, y: tangentRaw.y / tangentLength };
      const armTangentA = cross(armA, tangent), armTangentB = cross(armB, tangent);
      const tangentDenominator = bodyA.inverseMass + bodyB.inverseMass + armTangentA * armTangentA * bodyA.inverseInertia + armTangentB * armTangentB * bodyB.inverseInertia;
      if (tangentDenominator <= PHYSICS_EPSILON) return;
      const coefficient = Math.sqrt(colliderA.friction * colliderB.friction);
      const tangentImpulse = clamp(-dot(relative, tangent) / tangentDenominator, -impulseMagnitude * coefficient, impulseMagnitude * coefficient);
      this._applyPairImpulse(bodyA, bodyB, armA, armB, { x: tangent.x * tangentImpulse, y: tangent.y * tangentImpulse });
      if (Math.abs(impulseMagnitude) > PHYSICS_EPSILON) { this.wake(bodyA); this.wake(bodyB); }
    }
    _applyPairImpulse(bodyA, bodyB, armA, armB, impulse) {
      bodyA.velocity.x -= impulse.x * bodyA.inverseMass; bodyA.velocity.y -= impulse.y * bodyA.inverseMass;
      bodyB.velocity.x += impulse.x * bodyB.inverseMass; bodyB.velocity.y += impulse.y * bodyB.inverseMass;
      if (bodyA.inverseInertia) bodyA.angularVelocity -= cross(armA, impulse) * bodyA.inverseInertia * RAD_TO_DEG;
      if (bodyB.inverseInertia) bodyB.angularVelocity += cross(armB, impulse) * bodyB.inverseInertia * RAD_TO_DEG;
    }
    _updateSleeping(dt, contacts) {
      const touching = new Set();
      contacts.forEach(contact => { if (!contact.trigger) { touching.add(contact.bodyA); touching.add(contact.bodyB); } });
      this.bodies.forEach(body => {
        if (body.type !== BODY_TYPES.DYNAMIC || !body.allowSleep || !body.enabled) { body.sleeping = false; body.sleepTime = 0; return; }
        const quiet = Math.hypot(body.velocity.x, body.velocity.y) <= this.sleepLinearThreshold && Math.abs(body.angularVelocity) <= this.sleepAngularThreshold;
        if (quiet && (touching.has(body) || Math.hypot(this.gravity.x, this.gravity.y) * Math.abs(body.gravityScale) < PHYSICS_EPSILON)) {
          body.sleepTime += dt;
          if (body.sleepTime >= this.timeToSleep) this.sleep(body);
        } else { body.sleepTime = 0; body.sleeping = false; }
      });
    }
    _eventPayload(contact, phase) {
      return {
        phase, trigger: contact.trigger,
        a: contact.bodyA.entityId, b: contact.bodyB.entityId,
        bodyA: contact.bodyA, bodyB: contact.bodyB,
        colliderA: contact.colliderA, colliderB: contact.colliderB,
        normal: { ...contact.normal }, penetration: contact.penetration, point: { ...contact.point }
      };
    }
    _emitContactChanges(next, engine = this.engine) {
      const events = engine?.events;
      next.forEach((contact, key) => {
        const previous = this.contacts.get(key);
        if (previous && previous.trigger !== contact.trigger) this._emitContactEvent(events, previous, 'end');
        this._emitContactEvent(events, contact, previous && previous.trigger === contact.trigger ? 'stay' : 'start');
      });
      this.contacts.forEach((contact, key) => { if (!next.has(key)) this._emitContactEvent(events, contact, 'end'); });
      this.contacts = next;
    }
    _emitContactEvent(events, contact, phase) {
      if (!events) return;
      const triggerPhase = phase === 'start' ? 'enter' : phase === 'end' ? 'exit' : 'stay';
      const name = contact.trigger ? `physics:trigger${triggerPhase}` : `physics:collision${phase}`;
      const payload = this._eventPayload(contact, contact.trigger ? triggerPhase : phase);
      events.emit(name, payload);
      events.emit('physics:contact', { ...payload, type: name });
    }
    _removeBodyContacts(entityId) {
      const remaining = new Map();
      this.contacts.forEach((contact, key) => {
        if (contact.bodyA.entityId === entityId || contact.bodyB.entityId === entityId) this._emitContactEvent(this.engine?.events, contact, 'end');
        else remaining.set(key, contact);
      });
      this.contacts = remaining;
    }
  }

  class Box2DPhysicsAdapter extends PhysicsAdapter {
    constructor(box2d = global.Box2D || global.planck, options = {}) {
      if (box2d && !box2d.World && typeof box2d === 'object' && arguments.length === 1) { options = box2d; box2d = global.Box2D || global.planck; }
      super(options); this.name = 'box2d'; this.api = box2d || null; this.world = null; this.nativeBodies = new Map(); this.usingNative = false; this.initialize(options);
    }
    initialize(options = {}) {
      super.initialize(options);
      this.pixelsPerMeter = Math.max(PHYSICS_EPSILON, finite(options.pixelsPerMeter, 100));
      if (!this.api?.World) { this.backend = 'builtin'; return this; }
      try {
        const gravity = this._nativeVector(this.gravity.x / this.pixelsPerMeter, this.gravity.y / this.pixelsPerMeter);
        try { this.world = new this.api.World(gravity); } catch (_) { this.world = this.api.World(gravity); }
        this.usingNative = Boolean(this.world && (this.world.step || this.world.Step) && (this.world.createBody || this.world.CreateBody));
        this.backend = this.usingNative ? 'box2d' : 'builtin';
      } catch (_) { this.world = null; this.usingNative = false; this.backend = 'builtin'; }
      return this;
    }
    setGravity(x, y) {
      super.setGravity(x, y);
      if (this.usingNative) {
        const value = this._nativeVector(this.gravity.x / this.pixelsPerMeter, this.gravity.y / this.pixelsPerMeter);
        this.world.setGravity?.(value); this.world.SetGravity?.(value);
      }
      return this;
    }
    destroyBody(entityId) {
      const nativeBody = this.nativeBodies.get(entityId);
      if (nativeBody && this.world) {
        try { if (this.world.destroyBody) this.world.destroyBody(nativeBody); else this.world.DestroyBody?.(nativeBody); } catch (_) { /* Already removed. */ }
      }
      this.nativeBodies.delete(entityId);
      return super.destroyBody(entityId);
    }
    clear() { super.clear(); this.nativeBodies.clear(); }
    sync(engine, phase = 'both') {
      if (!this.usingNative) return super.sync(engine, phase);
      this.engine = engine;
      if (phase !== 'after') {
        super.sync(engine, 'before');
        try { this.bodies.forEach(body => this._writeNativeBody(body)); } catch (error) { this._fallback(error); }
      }
      if (phase !== 'before') {
        if (this.usingNative) {
          try { this.bodies.forEach(body => this._readNativeBody(body)); } catch (error) { this._fallback(error); }
        }
        super.sync(engine, 'after');
      }
    }
    step(dt, engine = this.engine) {
      if (!this.usingNative) return super.step(dt, engine);
      dt = clamp(finite(dt, 0), 0, 0.25); if (dt <= 0) return;
      try {
        if (this.world.step) this.world.step(dt); else this.world.Step(dt, this.velocityIterations, 3);
        this.bodies.forEach(body => this._readNativeBody(body));
        const contacts = this._detectContacts();
        this._updateSleeping(dt, contacts); this._emitContactChanges(contacts, engine);
      } catch (error) { this._fallback(error); super.step(dt, engine); }
    }
    _nativeVector(x, y) {
      if (this.api?.Vec2) {
        try { return this.api.Vec2(x, y); } catch (_) { return new this.api.Vec2(x, y); }
      }
      return { x, y };
    }
    _writeNativeBody(body) {
      let nativeBody = this.nativeBodies.get(body.entityId);
      const signature = JSON.stringify(body.colliders.map(collider => ({
        id: collider.id, shape: collider.shape, width: collider.width, height: collider.height, radius: collider.radius,
        offsetX: collider.offsetX, offsetY: collider.offsetY, rotation: collider.rotation, trigger: collider.isTrigger
      })));
      if (nativeBody && nativeBody.__ah2dColliderSignature !== signature) {
        try { if (this.world.destroyBody) this.world.destroyBody(nativeBody); else this.world.DestroyBody?.(nativeBody); } catch (_) { /* Recreated below. */ }
        this.nativeBodies.delete(body.entityId); nativeBody = null;
      }
      if (!nativeBody) {
        const definition = {
          type: body.type, position: this._nativeVector(body.position.x / this.pixelsPerMeter, body.position.y / this.pixelsPerMeter),
          angle: body.rotation * DEG_TO_RAD, linearDamping: body.linearDamping, angularDamping: body.angularDamping,
          fixedRotation: body.fixedRotation, allowSleep: body.allowSleep, awake: !body.sleeping, userData: body.entityId
        };
        nativeBody = this.world.createBody ? this.world.createBody(definition) : this.world.CreateBody(definition);
        nativeBody.__ah2dColliderSignature = signature;
        nativeBody.setUserData?.(body.entityId); nativeBody.SetUserData?.(body.entityId);
        this.nativeBodies.set(body.entityId, nativeBody);
        const totalArea = body.colliders.reduce((sum, collider) => sum + (collider.shape === 'circle' ? Math.PI * collider.radius * collider.radius : collider.width * collider.height), 0) / (this.pixelsPerMeter * this.pixelsPerMeter);
        body.colliders.forEach(collider => {
          let shape;
          const offset = this._nativeVector(collider.offsetX / this.pixelsPerMeter, collider.offsetY / this.pixelsPerMeter);
          if (collider.shape === 'circle' && this.api.Circle) shape = this.api.Circle(offset, collider.radius / this.pixelsPerMeter);
          else if (collider.shape === 'box' && this.api.Box) shape = this.api.Box(collider.width * 0.5 / this.pixelsPerMeter, collider.height * 0.5 / this.pixelsPerMeter, offset, collider.rotation * DEG_TO_RAD);
          if (!shape || !nativeBody.createFixture) return;
          const fixture = nativeBody.createFixture(shape, {
            density: body.type === 'dynamic' ? body.mass / Math.max(PHYSICS_EPSILON, totalArea) : 0,
            friction: collider.friction, restitution: collider.restitution, isSensor: collider.isTrigger,
            filterCategoryBits: collider.categoryBits, filterMaskBits: collider.maskBits, filterGroupIndex: collider.groupIndex
          });
          fixture?.setUserData?.({ entityId: body.entityId, colliderId: collider.id });
        });
      }
      const position = this._nativeVector(body.position.x / this.pixelsPerMeter, body.position.y / this.pixelsPerMeter);
      nativeBody.setTransform?.(position, body.rotation * DEG_TO_RAD); nativeBody.SetTransform?.(position, body.rotation * DEG_TO_RAD);
      const velocity = this._nativeVector(body.velocity.x / this.pixelsPerMeter, body.velocity.y / this.pixelsPerMeter);
      nativeBody.setLinearVelocity?.(velocity); nativeBody.SetLinearVelocity?.(velocity);
      nativeBody.setAngularVelocity?.(body.angularVelocity * DEG_TO_RAD); nativeBody.SetAngularVelocity?.(body.angularVelocity * DEG_TO_RAD);
      nativeBody.setGravityScale?.(body.gravityScale); nativeBody.setFixedRotation?.(body.fixedRotation);
      nativeBody.setAwake?.(!body.sleeping); nativeBody.SetAwake?.(!body.sleeping);
      if (body.force.x || body.force.y) {
        const force = this._nativeVector(body.force.x / this.pixelsPerMeter, body.force.y / this.pixelsPerMeter);
        nativeBody.applyForceToCenter?.(force, true); nativeBody.ApplyForce?.(force, nativeBody.GetWorldCenter?.());
      }
    }
    _readNativeBody(body) {
      const nativeBody = this.nativeBodies.get(body.entityId); if (!nativeBody) return;
      const position = nativeBody.getPosition?.() || nativeBody.GetPosition?.();
      const velocity = nativeBody.getLinearVelocity?.() || nativeBody.GetLinearVelocity?.();
      const angle = nativeBody.getAngle?.() ?? nativeBody.GetAngle?.();
      const angularVelocity = nativeBody.getAngularVelocity?.() ?? nativeBody.GetAngularVelocity?.();
      if (position) { body.position.x = finite(position.x, 0) * this.pixelsPerMeter; body.position.y = finite(position.y, 0) * this.pixelsPerMeter; }
      if (velocity) { body.velocity.x = finite(velocity.x, 0) * this.pixelsPerMeter; body.velocity.y = finite(velocity.y, 0) * this.pixelsPerMeter; }
      if (angle != null) body.rotation = finite(angle, 0) * RAD_TO_DEG;
      if (angularVelocity != null) body.angularVelocity = finite(angularVelocity, 0) * RAD_TO_DEG;
      const awake = nativeBody.isAwake?.() ?? nativeBody.IsAwake?.(); if (awake != null) body.sleeping = !awake;
    }
    _fallback(error) {
      this.world = null; this.nativeBodies.clear(); this.usingNative = false; this.backend = 'builtin';
      this.engine?.events.emit('physics:fallback', { adapter: this, error });
    }
  }

  class RuntimeAdapter {
    constructor(name) { this.name = name; this.engine = null; this.backend = 'editor-bridge'; this.native = false; }
    mount(engine, target) { this.engine = engine; this.target = target; }
    render() {}
    destroy() { this.engine = null; this.target = null; }
  }

  class PixiRuntimeAdapter extends RuntimeAdapter {
    constructor(PIXI = global.PIXI) { super('pixijs'); this.PIXI = PIXI; this.objects = new Map(); this.native = Boolean(PIXI?.Application); this.backend = this.native ? 'pixijs' : 'editor-bridge'; }
    mount(engine, target) {
      super.mount(engine, target);
      /* The editor owns its preview canvas. A host that provides PIXI can consume the
         ECS through this adapter without the adapter inserting a second canvas. */
      this.native = Boolean(this.PIXI?.Application);
      this.backend = this.native ? 'pixijs' : 'editor-bridge';
    }
    render() { /* Entities are intentionally mapped by the host project. */ }
    destroy() { this.app?.destroy?.(true); this.objects.clear(); super.destroy(); }
  }

  class PhaserRuntimeAdapter extends RuntimeAdapter {
    constructor(Phaser = global.Phaser) { super('phaserjs'); this.Phaser = Phaser; this.native = Boolean(Phaser?.Game); this.backend = this.native ? 'phaserjs' : 'editor-bridge'; }
    mount(engine, target) { super.mount(engine, target); this.native = Boolean(this.Phaser?.Game); this.backend = this.native ? 'phaserjs' : 'editor-bridge'; }
  }

  class CustomRuntimeAdapter extends RuntimeAdapter {
    constructor(hooks = {}) { super('custom'); this.hooks = hooks; this.native = true; this.backend = 'custom'; }
    mount(engine, target) { super.mount(engine, target); this.hooks.mount?.(engine, target); }
    render(alpha) { this.hooks.render?.(this.engine, alpha); }
    destroy() { this.hooks.destroy?.(); super.destroy(); }
  }

  class Engine {
    constructor(options = {}) {
      this.events = new EventBus();
      this.ecs = new ECS(this.events);
      this.graph = new SceneGraph(this.events);
      this.transform = new TransformSystem(this);
      this.camera = new CameraSystem(this);
      this.lighting = new LightingSystem(this);
      this.shadows = new ShadowSystem(this);
      this.animation = new AnimationSystem(this);
      this.postProcess = new PostProcessSystem(this);
      this.tilemap = new TilemapSystem(this);
      const physicsOptions = { ...(options.physicsOptions || {}) };
      if (options.gravity && !physicsOptions.gravity) physicsOptions.gravity = options.gravity;
      if (options.physics instanceof PhysicsAdapter) {
        this.physics = options.physics;
        if (!this.physics.initialized) this.physics.initialize(physicsOptions);
      } else if (options.physics === 'builtin') this.physics = new PhysicsAdapter(physicsOptions);
      else this.physics = new Box2DPhysicsAdapter(options.box2d, physicsOptions);
      this.physics.engine = this;
      this.runtime = null;
      this.running = false;
      this.lastTime = 0;
      this.frameHandle = null;
      this.playSnapshot = null;
      this.restoreOnStop = true;
      this.runtimeTarget = null;
      this.document = null;
      this.activeSceneId = null;
      if (options.runtime) this.useRuntime(options.runtime, options.runtimeOptions);
    }
    useRuntime(type, options = {}) {
      const target = this.runtimeTarget;
      this.runtime?.destroy();
      if (type instanceof RuntimeAdapter) this.runtime = type;
      else if (type === 'pixijs') this.runtime = new PixiRuntimeAdapter(options.PIXI);
      else if (type === 'phaserjs') this.runtime = new PhaserRuntimeAdapter(options.Phaser);
      else this.runtime = new CustomRuntimeAdapter(options);
      if (this.running && target) this.runtime.mount(this, target);
      this.events.emit('runtime:change', { runtime: this.runtime, name: this.runtime.name });
      return this.runtime;
    }
    createEntity(data = {}) {
      const id = this.ecs.create(data.id);
      const components = data.components && typeof data.components === 'object' ? data.components : {};
      const transformSource = components.Transform || data.transform || {};
      this.ecs.add(id, 'Name', clone(components.Name || { value: data.name || 'Game Object' }));
      this.ecs.add(id, 'Transform', {
        ...clone(transformSource),
        x: finite(transformSource.x ?? data.x, 0),
        y: finite(transformSource.y ?? data.y, 0),
        rotation: finite(transformSource.rotation ?? data.rotation ?? data.rot, 0),
        scaleX: finite(transformSource.scaleX ?? data.scaleX ?? data.sx, 1),
        scaleY: finite(transformSource.scaleY ?? data.scaleY ?? data.sy, 1),
        world: Array.isArray(transformSource.world) ? [...transformSource.world] : [1, 0, 0, 1, 0, 0]
      });
      Object.entries(components).forEach(([type, value]) => {
        if (type !== 'Name' && type !== 'Transform') this.ecs.add(id, type, clone(value));
      });
      if (data.visible === false && !this.ecs.has(id, 'Hidden')) this.ecs.add(id, 'Hidden', {});
      if (data.locked && !this.ecs.has(id, 'Locked')) this.ecs.add(id, 'Locked', {});
      if (data.kind && !this.ecs.has(id, 'Renderable')) this.ecs.add(id, 'Renderable', { kind: data.kind, width: data.w, height: data.h, color: data.color, assetId: data.assetId, imageSrc: data.imageSrc });
      if (data.prefab && !this.ecs.has(id, 'PrefabInstance')) this.ecs.add(id, 'PrefabInstance', { assetId: data.assetId || null });
      const rigidbody = data.rigidbody || data.rigidBody;
      if (rigidbody && !this.ecs.has(id, 'Rigidbody')) this.ecs.add(id, 'Rigidbody', clone(rigidbody));
      if (data.collider && !this.ecs.has(id, 'Collider')) this.ecs.add(id, 'Collider', clone(data.collider));
      this.graph.attach(id, data.parentId || null);
      return id;
    }
    load(document, options = {}) {
      if (typeof options === 'string') options = { sceneId: options };
      const source = document && typeof document === 'object' ? document : {};
      const scenes = Array.isArray(source.scenes) ? source.scenes : [];
      const requestedSceneId = options.sceneId || source.currentSceneId || source.meta?.currentSceneId || null;
      const activeScene = scenes.length
        ? (scenes.find(scene => scene?.id === requestedSceneId) || (options.sceneId ? null : scenes[0]))
        : null;
      if (options.sceneId && scenes.length && !activeScene) throw new Error(`Unknown Scene: ${options.sceneId}`);
      const entities = activeScene
        ? (Array.isArray(activeScene.objects) ? activeScene.objects : (Array.isArray(activeScene.scene) ? activeScene.scene : []))
        : (Array.isArray(source.scene) ? source.scene : (Array.isArray(source.entities) ? source.entities : []));
      this.document = clone(source);
      this.activeSceneId = activeScene?.id || null;
      this.postProcess.load(source.postProcess);
      if (activeScene) {
        this.document.currentSceneId = activeScene.id;
        if (this.document.meta && typeof this.document.meta === 'object') this.document.meta.currentSceneId = activeScene.id;
      }
      this.physics.clear(); this.ecs.clear(); this.graph.clear();
      entities.forEach(entity => this.createEntity(entity));
      this.transform.update(); this.events.emit('document:load', source);
      if (activeScene) this.events.emit('scene:change', { id: activeScene.id, name: activeScene.name || 'Scene', scene: activeScene, engine: this });
      return this;
    }
    loadScene(sceneId) {
      if (!this.document) throw new Error('Load a project before switching Scene');
      return this.load(this.document, { sceneId });
    }
    export() {
      return {
        format: 'AH2D', version: 3, engine: VERSION,
        postProcess: this.postProcess.toJSON(),
        entities: [...this.ecs.entities].map(id => ({
          id,
          name: this.ecs.get(id, 'Name')?.value,
          parentId: this.graph.getParent(id),
          components: Object.fromEntries([...this.ecs.components].filter(([, store]) => store.has(id)).map(([type, store]) => [type, clone(store.get(id))]))
        }))
      };
    }
    update(dt) {
      dt = clamp(finite(dt, 0), 0, 0.25);
      this.animation.update(dt);
      this.transform.update();
      this.physics.sync(this, 'before');
      this.physics.step(dt, this);
      this.physics.sync(this, 'after');
      this.transform.update();
      this.events.emit('engine:update', { dt, engine: this });
      return this;
    }
    captureSnapshot() {
      this.transform.update();
      return {
        document: clone(this.export()),
        physics: clone(this.physics.snapshot()),
        animationTime: this.animation.time,
        activeCamera: this.camera.active
      };
    }
    restoreSnapshot(snapshot = this.playSnapshot) {
      if (!snapshot) return false;
      const document = snapshot.document || snapshot;
      this.load(clone(document));
      this.animation.time = finite(snapshot.animationTime, 0);
      this.camera.active = snapshot.activeCamera || null;
      this.transform.update();
      this.physics.sync(this, 'before');
      if (snapshot.physics) this.physics.restore(snapshot.physics);
      this.physics.sync(this, 'after');
      this.transform.update();
      this.events.emit('runtime:restore', { snapshot, engine: this });
      return true;
    }
    frame = time => {
      if (!this.running) return;
      const dt = Math.min(0.05, (time - this.lastTime) / 1000 || 0);
      this.lastTime = time; this.update(dt); this.runtime?.render(1);
      this.frameHandle = this._requestFrame(this.frame);
    };
    _requestFrame(callback) {
      if (typeof global.requestAnimationFrame === 'function') return global.requestAnimationFrame(callback);
      return global.setTimeout(() => callback(Date.now()), 16);
    }
    _cancelFrame(handle) {
      if (handle == null) return;
      if (typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(handle);
      else global.clearTimeout?.(handle);
    }
    start(target = this.runtimeTarget, options = {}) {
      if (target && typeof target === 'object' && !('nodeType' in target) && (target.restoreOnStop !== undefined || target.snapshot !== undefined) && arguments.length === 1) {
        options = target; target = this.runtimeTarget;
      }
      if (this.running) return this;
      this.runtimeTarget = target || this.runtimeTarget;
      this.restoreOnStop = options.restoreOnStop !== false;
      this.playSnapshot = options.snapshot === false ? null : this.captureSnapshot();
      this.runtime?.mount(this, this.runtimeTarget);
      this.running = true;
      this.lastTime = global.performance?.now?.() ?? Date.now();
      this.events.emit('runtime:start', { runtime: this.runtime, snapshot: this.playSnapshot, engine: this });
      this.frameHandle = this._requestFrame(this.frame);
      return this;
    }
    pause() {
      if (!this.running) return this;
      this.running = false;
      this._cancelFrame(this.frameHandle); this.frameHandle = null;
      this.events.emit('runtime:pause', { engine: this });
      return this;
    }
    resume() {
      if (this.running) return this;
      this.running = true;
      this.lastTime = global.performance?.now?.() ?? Date.now();
      this.events.emit('runtime:resume', { engine: this });
      this.frameHandle = this._requestFrame(this.frame);
      return this;
    }
    stop(options = {}) {
      if (typeof options === 'boolean') options = { restore: options };
      const wasRunning = this.running;
      this.running = false;
      this._cancelFrame(this.frameHandle); this.frameHandle = null;
      const shouldRestore = options.restore ?? this.restoreOnStop;
      if (shouldRestore && this.playSnapshot) this.restoreSnapshot(this.playSnapshot);
      this.events.emit('runtime:stop', { restored: Boolean(shouldRestore && this.playSnapshot), wasRunning, engine: this });
      if (!options.keepSnapshot) this.playSnapshot = null;
      return this;
    }
  }

  class EditorBridge {
    constructor(engine) { this.engine = engine; this.lastSignature = ''; }
    sync(editorState) {
      const scene = editorState?.scene || [];
      const postProcess = editorState?.postProcess;
      const signature = JSON.stringify({ scene, postProcess });
      if (signature === this.lastSignature) return false;
      this.lastSignature = signature;
      this.engine.load({ scene, postProcess });
      return true;
    }
  }

  global.AH2D = Object.freeze({
    VERSION, Engine, EventBus, ECS, SceneGraph, TransformSystem, CameraSystem,
    LightingSystem, ShadowSystem, AnimationSystem, PostProcessSystem, TilemapSystem,
    DEFAULT_POST_PROCESS_EFFECTS, createDefaultPostProcess,
    BODY_TYPES, COLLIDER_SHAPES, PhysicsAdapter, Box2DPhysicsAdapter,
    RuntimeAdapter, PixiRuntimeAdapter, PhaserRuntimeAdapter, CustomRuntimeAdapter,
    EditorBridge
  });
})(window);
