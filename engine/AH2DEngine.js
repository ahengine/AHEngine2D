(function (global) {
  'use strict';

  const DataModel = global.AH2DDataModel || (
    typeof module === 'object' && module.exports ? require('./AH2DDataModel.js') : null
  );
  if (!DataModel) throw new Error('AH2DDataModel must be loaded before AH2DEngine');

  const VERSION = '0.3.0';
  const uid = () => `ah2d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  class EventBus {
    constructor() { this.listeners = new Map(); }
    on(type, fn) { const set = this.listeners.get(type) || new Set(); set.add(fn); this.listeners.set(type, set); return () => set.delete(fn); }
    emit(type, payload) { (this.listeners.get(type) || []).forEach(fn => fn(payload)); }
  }

  class ECS {
    constructor(events, schemas = DataModel.createDefaultComponentRegistry()) {
      this.events = events;
      this.schemas = schemas;
      this.entities = new Set();
      this.components = new Map();
      this.destroyGuard = null;
    }
    bindDestroyGuard(guard) { this.destroyGuard = typeof guard === 'function' ? guard : null; return this; }
    create(id = uid()) {
      if (typeof id !== 'string' || !id.trim()) throw new DataModel.ComponentSchemaError('E_ENTITY_ID', 'Entity id must be a non-empty string');
      if (this.entities.has(id)) throw new DataModel.ComponentSchemaError('E_ENTITY_EXISTS', `Entity already exists: ${id}`);
      this.entities.add(id);
      try {
        this.events.emit('entity:create', id);
      } catch (error) {
        this.entities.delete(id);
        try { this.events.emit('entity:createRollback', id); } catch (_) { /* Preserve the original listener error. */ }
        throw error;
      }
      return id;
    }
    destroy(id, options = {}) {
      if (!this.entities.has(id)) return false;
      if (options[GRAPH_INTERNAL] !== true) {
        this.destroyGuard?.(id);
        this.events.emit('entity:beforeDestroy', id);
      }
      this.entities.delete(id);
      this.components.forEach(store => store.delete(id));
      if (options.emit !== false) this.events.emit('entity:destroy', id);
      return true;
    }
    add(id, type, value = {}) {
      const canonical = this.schemas.resolve(type);
      if (!canonical) throw new DataModel.ComponentSchemaError('E_COMPONENT_NAME', `Invalid or unknown Component name: ${type || '(empty)'}`);
      const normalized = this.schemas.assert(canonical, value, { profile: DataModel.PROFILES.RUNTIME });
      if (!this.entities.has(id)) this.create(id);
      const store = this.components.get(canonical) || new Map();
      store.set(id, normalized); this.components.set(canonical, store); return normalized;
    }
    get(id, type) { const canonical = this.schemas.resolve(type); return canonical ? this.components.get(canonical)?.get(id) : undefined; }
    has(id, type) { const canonical = this.schemas.resolve(type); return canonical ? (this.components.get(canonical)?.has(id) || false) : false; }
    remove(id, type) { const canonical = this.schemas.resolve(type); if (canonical) this.components.get(canonical)?.delete(id); }
    query(...types) { return [...this.entities].filter(id => types.every(type => this.has(id, type))); }
    clear() { this.entities.clear(); this.components.clear(); }
  }

  const graphError = (code, message, details) => new DataModel.ComponentSchemaError(code, message, { details });
  const GRAPH_INTERNAL = Symbol('AH2D.SceneGraph.internal');
  const assertGraphId = (id, label = 'Entity') => {
    if (typeof id !== 'string' || !id.trim()) throw graphError('E_GRAPH_ENTITY_ID', label + ' id must be a non-empty string', { id });
    return id;
  };

  class SceneGraph {
    constructor(events) {
      this.events = events;
      this.nodes = new Set();
      this.parent = new Map();
      this.children = new Map();
      this.transforms = null;
      this.entityExists = null;
    }
    bindTransformSystem(transforms) { this.transforms = transforms || null; return this; }
    bindEntityStore(entityExists) { this.entityExists = typeof entityExists === 'function' ? entityExists : null; return this; }
    add(id) {
      assertGraphId(id);
      if (this.entityExists && !this.entityExists(id)) {
        throw graphError('E_GRAPH_ENTITY_MISSING', 'Cannot register a Scene Graph node without an ECS Entity: ' + id, { id });
      }
      if (!this.nodes.has(id)) {
        this.nodes.add(id);
        this.children.set(id, new Set());
        this.events?.emit('graph:add', { id });
      }
      return id;
    }
    ensure(id) { return this.add(id); }
    has(id) { return this.nodes.has(id); }
    _assertNode(id, label = 'Entity') {
      assertGraphId(id, label);
      if (!this.nodes.has(id)) throw graphError('E_GRAPH_ENTITY_MISSING', label + ' does not exist in the Scene Graph: ' + id, { id, label });
      return id;
    }
    _assertAttach(child, parent) {
      this._assertNode(child, 'Child');
      if (parent == null) return null;
      assertGraphId(parent, 'Parent');
      if (!this.nodes.has(parent)) {
        throw graphError('E_DANGLING_PARENT', 'Parent does not exist in the Scene Graph: ' + parent, { child, parent });
      }
      if (child === parent || this.isDescendant(parent, child)) {
        throw graphError('E_GRAPH_CYCLE', 'SceneGraph cycle detected while parenting ' + child + ' to ' + parent, { child, parent });
      }
      return parent;
    }
    _setParent(child, parent) {
      const oldParent = this.parent.get(child) || null;
      if (oldParent === parent) return oldParent;
      if (oldParent != null) this.children.get(oldParent)?.delete(child);
      if (parent == null) this.parent.delete(child);
      else {
        this.parent.set(child, parent);
        this.children.get(parent).add(child);
      }
      return oldParent;
    }
    attach(child, parent = null, options = {}) {
      if (typeof options === 'boolean') options = { preserveWorld: options };
      parent = parent === undefined ? null : parent;
      this._assertAttach(child, parent);
      const oldParent = this.getParent(child);
      if (oldParent === parent) return child;
      const preserveWorld = options.preserveWorld === true;
      const preservedLocal = preserveWorld ? this._requireTransforms().computeLocalForParent(child, parent) : null;
      this._setParent(child, parent);
      if (preservedLocal) this.transforms._applyLocal(child, preservedLocal);
      else this.transforms?.markDirty(child);
      this.transforms?.update();
      this.events?.emit('graph:attach', { child, parent, oldParent, preserveWorld });
      return child;
    }
    reparent(child, parent = null, options = {}) { return this.attach(child, parent, options); }
    detach(child, options = {}) { return this.attach(child, null, options); }
    getParent(id) { return this.parent.get(id) || null; }
    getChildren(id) { return [...(this.children.get(id) || [])]; }
    roots(ids = this.nodes) { return [...ids].filter(id => this.nodes.has(id) && !this.parent.has(id)); }
    ancestors(id, options = {}) {
      this._assertNode(id);
      const output = options.includeSelf ? [id] : [];
      const seen = new Set(output);
      let current = this.getParent(id);
      while (current != null) {
        if (seen.has(current)) throw graphError('E_GRAPH_CYCLE', 'SceneGraph cycle detected at ' + current, { id, current });
        output.push(current);
        seen.add(current);
        current = this.getParent(current);
      }
      return output;
    }
    getAncestors(id, options = {}) { return this.ancestors(id, options); }
    path(id) { return this.ancestors(id, { includeSelf: true }).reverse(); }
    isDescendant(id, possibleAncestor) {
      if (!this.nodes.has(id) || !this.nodes.has(possibleAncestor) || id === possibleAncestor) return false;
      let current = this.getParent(id);
      const seen = new Set();
      while (current != null) {
        if (current === possibleAncestor) return true;
        if (seen.has(current)) throw graphError('E_GRAPH_CYCLE', 'SceneGraph cycle detected at ' + current, { id, possibleAncestor });
        seen.add(current);
        current = this.getParent(current);
      }
      return false;
    }
    isAncestor(id, possibleDescendant) { return this.isDescendant(possibleDescendant, id); }
    traverse(root = null, visitor = null, options = {}) {
      if (typeof root === 'function') { options = visitor || {}; visitor = root; root = null; }
      else if (root && typeof root === 'object' && !Array.isArray(root)) { options = root; visitor = null; root = null; }
      else if (visitor && typeof visitor === 'object') { options = visitor; visitor = null; }
      const starts = root == null ? this.roots() : [this._assertNode(root)];
      const order = options.order === 'post' ? 'post' : 'pre';
      const output = [];
      const seen = new Set();
      const stack = starts.slice().reverse().map(id => ({ id, depth: 0, expanded: false }));
      while (stack.length) {
        const entry = stack.pop();
        if (order === 'post' && !entry.expanded) {
          if (seen.has(entry.id)) throw graphError('E_GRAPH_CYCLE', 'SceneGraph cycle detected at ' + entry.id, { id: entry.id });
          seen.add(entry.id);
          stack.push({ ...entry, expanded: true });
          const children = this.getChildren(entry.id);
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            stack.push({ id: child, depth: entry.depth + 1, expanded: false });
          }
          continue;
        }
        if (order === 'pre') {
          if (seen.has(entry.id)) throw graphError('E_GRAPH_CYCLE', 'SceneGraph cycle detected at ' + entry.id, { id: entry.id });
          seen.add(entry.id);
        }
        output.push(entry.id);
        let descend = true;
        if (typeof visitor === 'function') {
          const context = { depth: entry.depth, parentId: this.getParent(entry.id) };
          const cachePath = value => {
            Object.defineProperty(context, 'path', {
              value, enumerable: true, configurable: true, writable: true
            });
            return value;
          };
          Object.defineProperty(context, 'path', {
            enumerable: true,
            configurable: true,
            get: () => cachePath(this.path(entry.id)),
            set: value => { cachePath(value); }
          });
          descend = visitor(entry.id, context) !== false;
        }
        if (order === 'pre' && descend) {
          const children = this.getChildren(entry.id);
          for (let index = children.length - 1; index >= 0; index -= 1) {
            const child = children[index];
            stack.push({ id: child, depth: entry.depth + 1, expanded: false });
          }
        }
      }
      return output;
    }
    descendants(id, options = {}) {
      const values = this.traverse(id, null, options);
      if (options.includeSelf) return values;
      return options.order === 'post' ? values.slice(0, -1) : values.slice(1);
    }
    getDescendants(id, options = {}) { return this.descendants(id, options); }
    remove(id, options = {}) {
      this._assertNode(id);
      if (typeof options === 'string') options = { childPolicy: options };
      if (this.entityExists?.(id) && options[GRAPH_INTERNAL] !== true) {
        throw graphError('E_GRAPH_LIFECYCLE', 'Use Engine.destroyEntity() to remove an ECS-backed Scene Graph node', { id });
      }

      const childPolicy = options.childPolicy || options.children || options.mode || 'reject';
      if (!['reject', 'cascade', 'reparent', 'detach', 'root'].includes(childPolicy)) {
        throw graphError('E_GRAPH_CHILD_POLICY', 'Unknown Scene Graph child policy: ' + childPolicy, { id, childPolicy });
      }
      const directChildren = this.getChildren(id);
      if (directChildren.length && childPolicy === 'reject') {
        throw graphError('E_GRAPH_HAS_CHILDREN', 'Cannot remove ' + id + ' while it has children', { id, children: directChildren });
      }
      const emitGraph = (type, payload) => {
        if (Array.isArray(options.eventQueue)) options.eventQueue.push([type, payload]);
        else this.events?.emit(type, payload);
      };

      if (childPolicy === 'cascade') {
        const removed = this.descendants(id, { includeSelf: true, order: 'post' });
        if (typeof options.beforeCommit === 'function') options.beforeCommit(removed.slice());
        for (const target of removed) {
          const parent = this.getParent(target);
          if (parent != null) this.children.get(parent)?.delete(target);
          this.parent.delete(target);
          this.children.delete(target);
          this.nodes.delete(target);
          this.transforms?.forget(target);
        }
        emitGraph('graph:remove', { id, childPolicy, removed: removed.slice() });
        return removed;
      }
      const targetParent = childPolicy === 'reparent' ? this.getParent(id) : null;
      const preserveWorld = options.preserveWorld === true;
      const prepared = preserveWorld
        ? directChildren.map(child => [child, this._requireTransforms().computeLocalForParent(child, targetParent)])
        : [];
      if (typeof options.beforeCommit === 'function') options.beforeCommit([id]);
      for (const child of directChildren) {
        const oldParent = this._setParent(child, targetParent);
        emitGraph('graph:attach', { child, parent: targetParent, oldParent, preserveWorld });
      }
      for (const [child, local] of prepared) this.transforms._applyLocal(child, local);
      if (!preserveWorld) directChildren.forEach(child => this.transforms?.markDirty(child));
      const parent = this.getParent(id);
      if (parent != null) this.children.get(parent)?.delete(id);
      this.parent.delete(id);
      this.children.delete(id);
      this.nodes.delete(id);
      this.transforms?.forget(id);
      emitGraph('graph:remove', { id, childPolicy, removed: [id] });
      return [id];
    }
    _requireTransforms() {
      if (!this.transforms) throw graphError('E_TRANSFORM_SYSTEM_REQUIRED', 'A bound TransformSystem is required to preserve world transforms');
      return this.transforms;
    }
    clear(options = {}) {
      if (options[GRAPH_INTERNAL] !== true && this.entityExists && [...this.nodes].some(id => this.entityExists(id))) {
        throw graphError('E_GRAPH_LIFECYCLE', 'SceneGraph.clear() cannot remove live ECS Entities', { entities: [...this.nodes] });
      }
      this.nodes.clear();
      this.parent.clear();
      this.children.clear();
      this.transforms?.clear();
    }
  }


  const MATRIX_EPSILON = 1e-10;
  const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);
  const assertMatrix = (value, label = 'Transform matrix') => {
    if (!Array.isArray(value) || value.length !== 6 || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
      throw graphError('E_TRANSFORM_MATRIX', label + ' must contain six finite numbers', { value });
    }
    return value;
  };
  const matrix = (x = 0, y = 0, rotation = 0, sx = 1, sy = 1) => {
    const r = rotation * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return [c * sx, s * sx, -s * sy, c * sy, x, y];
  };
  const multiply = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ];
  const determinant = value => value[0] * value[3] - value[1] * value[2];
  const invert = value => {
    assertMatrix(value);
    const det = determinant(value);
    if (Math.abs(det) <= MATRIX_EPSILON) {
      throw graphError('E_NON_INVERTIBLE_TRANSFORM', 'Transform matrix is singular and cannot be inverted', { matrix: value.slice() });
    }
    return [
      value[3] / det, -value[1] / det, -value[2] / det, value[0] / det,
      (value[2] * value[5] - value[3] * value[4]) / det,
      (value[1] * value[4] - value[0] * value[5]) / det
    ];
  };
  const transformPoint = (value, point) => {
    assertMatrix(value);
    const x = Number(point?.x ?? point?.[0]), y = Number(point?.y ?? point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw graphError('E_TRANSFORM_POINT', 'Point must contain finite x and y values', { point });
    }
    return { x: value[0] * x + value[2] * y + value[4], y: value[1] * x + value[3] * y + value[5] };
  };
  const decompose = (value, options = {}) => {
    assertMatrix(value);
    const [a, b, c, d, x, y] = value;
    let rotation = Number.isFinite(options.rotationHint) ? options.rotationHint * Math.PI / 180 : 0;
    let scaleX = Math.hypot(a, b), scaleY = 0, shear = 0;
    if (scaleX > MATRIX_EPSILON) {
      rotation = Math.atan2(b, a);
      const axisX = a / scaleX, axisY = b / scaleX;
      shear = axisX * c + axisY * d;
      const perpendicularX = c - axisX * shear, perpendicularY = d - axisY * shear;
      scaleY = Math.hypot(perpendicularX, perpendicularY);
      if (determinant(value) < 0) scaleY = -scaleY;
    } else {
      const columnY = Math.hypot(c, d);
      if (columnY > MATRIX_EPSILON) {
        rotation = Math.atan2(-c, d);
        scaleX = 0;
        scaleY = columnY;
      } else {
        scaleX = 0;
        scaleY = 0;
      }
    }
    if (Number.isFinite(options.rotationHint) && (Math.abs(scaleX) > MATRIX_EPSILON || Math.abs(scaleY) > MATRIX_EPSILON)) {
      const hint = options.rotationHint;
      const canonical = rotation * 180 / Math.PI;
      const nearest = angle => angle + 360 * Math.round((hint - angle) / 360);
      const primary = nearest(canonical);
      const reflected = nearest(canonical + 180);
      if (Math.abs(reflected - hint) + MATRIX_EPSILON < Math.abs(primary - hint)) {
        rotation = reflected * Math.PI / 180;
        scaleX = -scaleX;
        scaleY = -scaleY;
      } else {
        rotation = primary * Math.PI / 180;
      }
    }
    const result = { x, y, rotation: rotation * 180 / Math.PI, scaleX, scaleY };
    const reconstructed = matrix(result.x, result.y, result.rotation, result.scaleX, result.scaleY);
    const linearMaximum = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
    const residual = Math.max(
      ...value.slice(0, 4).map((item, index) => Math.abs(item - reconstructed[index]))) / linearMaximum;
    result.skew = Math.atan2(shear, Math.max(MATRIX_EPSILON, Math.abs(scaleY))) * 180 / Math.PI;
    result.isTRS = residual <= (options.tolerance || 1e-8);
    if (options.strict && !result.isTRS) {
      throw graphError('E_TRANSFORM_SHEAR', 'Transform contains shear that cannot be represented by x/y/rotation/scale', {
        matrix: value.slice(), residual, tolerance: options.tolerance || 1e-8
      });
    }
    return result;
  };
  const matricesEqual = (a, b, epsilon = 1e-9) => Array.isArray(a) && Array.isArray(b)
    && a.length === 6 && b.length === 6 && a.every((value, index) => Math.abs(value - b[index]) <= epsilon);

  const Matrix2D = Object.freeze({
    identity: () => IDENTITY_MATRIX.slice(),
    compose: matrix,
    multiply,
    determinant,
    invert,
    decompose,
    transformPoint
  });

  class TransformSystem {
    constructor(engine) {
      this.engine = engine;
      this.dirty = new Set();
      this.localState = new Map();
      this.worldState = new Map();
    }
    _transform(id) {
      if (!this.engine.ecs.entities.has(id)) throw graphError('E_GRAPH_ENTITY_MISSING', 'Entity does not exist: ' + id, { id });
      const transform = this.engine.ecs.get(id, 'Transform');
      if (!transform) throw graphError('E_TRANSFORM_MISSING', 'Entity has no Transform component: ' + id, { id });
      return transform;
    }
    _localValues(transform) {
      const values = {
        x: transform.x ?? 0,
        y: transform.y ?? 0,
        rotation: transform.rotation ?? transform.rot ?? 0,
        scaleX: transform.scaleX ?? transform.sx ?? 1,
        scaleY: transform.scaleY ?? transform.sy ?? 1
      };
      for (const [field, value] of Object.entries(values)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw graphError('E_TRANSFORM_VALUE', 'Transform.' + field + ' must be a finite number', { field, value });
        }
      }
      return values;
    }
    _signature(transform) {
      const value = this._localValues(transform);
      return [value.x, value.y, value.rotation, value.scaleX, value.scaleY];
    }
    _detectChanges() {
      const active = new Set(this.engine.ecs.query('Transform'));
      for (const id of active) {
        const transform = this.engine.ecs.get(id, 'Transform');
        const signature = this._signature(transform);
        const previous = this.localState.get(id);
        const previousWorld = this.worldState.get(id);
        if (!previous || signature.some((value, index) => value !== previous[index]) || !matricesEqual(transform.world, previousWorld)) {
          this.dirty.add(id);
        }
      }
      for (const id of [...this.localState.keys()]) if (!active.has(id)) {
        if (this.engine.graph.has(id)) this.markDirty(id);
        this.forget(id);
      }
    }
    markDirty(id, options = {}) {
      this.dirty.add(id);
      if (options.descendants !== false && this.engine.graph.has(id)) {
        this.engine.graph.descendants(id).forEach(child => this.dirty.add(child));
      }
      return this;
    }
    invalidateAll() {
      this.engine.ecs.query('Transform').forEach(id => this.dirty.add(id));
      return this;
    }
    forget(id) {
      this.dirty.delete(id);
      this.localState.delete(id);
      this.worldState.delete(id);
      return this;
    }
    clear() {
      this.dirty.clear();
      this.localState.clear();
      this.worldState.clear();
      return this;
    }
    update(force = false, options = {}) {
      const { ecs, graph } = this.engine;
      this._detectChanges();
      if (force) this.invalidateAll();
      const changed = [];
      const visited = new Set();
      const stack = graph.roots(ecs.entities).slice().reverse().map(id => ({
        id, parentWorld: IDENTITY_MATRIX, parentDirty: false
      }));
      while (stack.length) {
        const { id, parentWorld, parentDirty } = stack.pop();
        if (visited.has(id)) throw graphError('E_GRAPH_CYCLE', 'SceneGraph cycle detected at ' + id, { id });
        visited.add(id);
        const transform = ecs.get(id, 'Transform');
        const isDirty = parentDirty || this.dirty.has(id) || (transform && !Array.isArray(transform.world));
        let world = parentWorld;
        if (transform) {
          const local = this._localValues(transform);
          if (isDirty) {
            world = multiply(parentWorld, matrix(local.x, local.y, local.rotation, local.scaleX, local.scaleY));
            transform.world = world;
            this.worldState.set(id, world.slice());
            this.localState.set(id, [local.x, local.y, local.rotation, local.scaleX, local.scaleY]);
            this.dirty.delete(id);
            changed.push(id);
          } else {
            world = transform.world;
          }
        }
        if (!transform) this.dirty.delete(id);
        const children = graph.getChildren(id);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push({ id: children[index], parentWorld: world, parentDirty: isDirty });
        }
      }
      if (visited.size !== ecs.entities.size) {
        const missing = [...ecs.entities].filter(id => !visited.has(id));
        throw graphError('E_GRAPH_DISCONNECTED', 'Scene Graph contains Entities that cannot be reached from a root', { entities: missing });
      }
      if (changed.length && options.emit !== false) this.engine.events.emit('transform:update', { entities: changed.slice(), engine: this.engine });
      return changed;
    }
    getLocalMatrix(id) {
      const local = this._localValues(this._transform(id));
      return matrix(local.x, local.y, local.rotation, local.scaleX, local.scaleY);
    }
    getWorldMatrix(id) {
      if (!this.engine.ecs.entities.has(id) || !this.engine.graph.has(id)) {
        throw graphError('E_GRAPH_ENTITY_MISSING', 'Entity does not exist: ' + id, { id });
      }
      this.update();
      let current = id;
      while (current != null) {
        const transform = this.engine.ecs.get(current, 'Transform');
        if (transform) return transform.world.slice();
        current = this.engine.graph.getParent(current);
      }
      return IDENTITY_MATRIX.slice();
    }
    getLocal(id) {
      const local = this._localValues(this._transform(id));
      return { ...local, matrix: matrix(local.x, local.y, local.rotation, local.scaleX, local.scaleY) };
    }
    getLocalTransform(id) { return this.getLocal(id); }
    _worldRotationHint(id) {
      const path = this.engine.graph.has(id) ? this.engine.graph.path(id) : [id];
      return path.reduce((rotation, entityId) => {
        const transform = this.engine.ecs.get(entityId, 'Transform');
        return rotation + (transform ? this._localValues(transform).rotation : 0);
      }, 0);
    }
    getWorld(id) {
      const world = this.getWorldMatrix(id);
      return { ...decompose(world, { rotationHint: this._worldRotationHint(id) }), matrix: world };
    }
    getWorldTransform(id) { return this.getWorld(id); }
    localToWorld(id, point) { return transformPoint(this.getWorldMatrix(id), point); }
    worldToLocal(id, point) { return transformPoint(invert(this.getWorldMatrix(id)), point); }
    _applyLocal(id, values) {
      const transform = this._transform(id);
      const local = this._localValues(values);
      transform.x = local.x;
      transform.y = local.y;
      transform.rotation = local.rotation;
      transform.scaleX = local.scaleX;
      transform.scaleY = local.scaleY;
      if (Object.prototype.hasOwnProperty.call(transform, 'rot')) transform.rot = local.rotation;
      if (Object.prototype.hasOwnProperty.call(transform, 'sx')) transform.sx = local.scaleX;
      if (Object.prototype.hasOwnProperty.call(transform, 'sy')) transform.sy = local.scaleY;
      this.markDirty(id);
      return this.getLocal(id);
    }
    setLocal(id, value = {}) {
      const current = this.getLocal(id);
      let next;
      if (Array.isArray(value)) {
        next = decompose(value, { strict: true, rotationHint: current.rotation });
      } else {
        if (!value || typeof value !== 'object') throw graphError('E_TRANSFORM_VALUE', 'Local Transform must be an object or matrix', { value });
        const source = Array.isArray(value.matrix)
          ? decompose(value.matrix, { strict: true, rotationHint: current.rotation })
          : value;
        next = {
          x: source.x ?? current.x,
          y: source.y ?? current.y,
          rotation: source.rotation ?? source.rot ?? current.rotation,
          scaleX: source.scaleX ?? source.sx ?? current.scaleX,
          scaleY: source.scaleY ?? source.sy ?? current.scaleY
        };
      }
      const result = this._applyLocal(id, next);
      this.update();
      return result;
    }
    computeLocalForParent(id, parentId = null, worldMatrix = null) {
      const current = this.getLocal(id);
      const world = worldMatrix ? assertMatrix(worldMatrix).slice() : this.getWorldMatrix(id);
      const localMatrix = parentId == null ? world : multiply(invert(this.getWorldMatrix(parentId)), world);
      return decompose(localMatrix, { strict: true, rotationHint: current.rotation });
    }
    setWorld(id, value) {
      const currentWorld = this.getWorldMatrix(id);
      let desired;
      if (Array.isArray(value)) {
        desired = assertMatrix(value).slice();
      } else if (value && Array.isArray(value.matrix || value.world)) {
        desired = assertMatrix(value.matrix || value.world).slice();
      } else {
        if (!value || typeof value !== 'object') throw graphError('E_TRANSFORM_VALUE', 'World Transform must be an object or matrix', { value });
        const requestedRotation = value.rotation ?? value.rot;
        const requestedScaleX = value.scaleX ?? value.sx;
        const requestedScaleY = value.scaleY ?? value.sy;
        const needsCurrentLinear = requestedRotation == null || requestedScaleX == null || requestedScaleY == null;
        const current = needsCurrentLinear
          ? decompose(currentWorld, { strict: true, rotationHint: this._worldRotationHint(id) })
          : null;
        desired = matrix(
          value.x ?? currentWorld[4],
          value.y ?? currentWorld[5],
          requestedRotation ?? current.rotation,
          requestedScaleX ?? current.scaleX,
          requestedScaleY ?? current.scaleY
        );
      }
      const local = this.computeLocalForParent(id, this.engine.graph.getParent(id), desired);
      this._applyLocal(id, local);
      this.update();
      return this.getWorld(id);
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
    load(source, options = {}) {
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
      if (options.emit !== false) this.engine?.events.emit('postprocess:change', { postProcess: this, engine: this.engine });
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
  const isPlainObject = value => {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };
  const assertDataModelCompatibility = document => {
    if (!Object.prototype.hasOwnProperty.call(document, 'dataModel')) return;
    const descriptor = document.dataModel;
    const fail = (code, message, pointer, details) => {
      const item = { severity: 'error', code, message, pointer };
      if (details !== undefined) item.details = details;
      throw new DataModel.ComponentSchemaError(code, message, { pointer, details, diagnostics: [item] });
    };
    if (!isPlainObject(descriptor)) fail('E_DATA_MODEL_TYPE', 'dataModel must be a plain object', '/dataModel');
    if (descriptor.id !== DataModel.DATA_MODEL_ID) {
      fail('E_DATA_MODEL_ID', `Unsupported data model id: ${descriptor.id == null ? '(missing)' : descriptor.id}`, '/dataModel/id', {
        expected: DataModel.DATA_MODEL_ID,
        actual: descriptor.id
      });
    }
    for (const [key, supported, typeCode, futureCode] of [
      ['version', DataModel.DATA_MODEL_VERSION, 'E_DATA_MODEL_VERSION_TYPE', 'E_FUTURE_DATA_MODEL_VERSION'],
      ['componentSchemaVersion', DataModel.COMPONENT_SCHEMA_VERSION, 'E_COMPONENT_SCHEMA_VERSION_TYPE', 'E_FUTURE_COMPONENT_SCHEMA_VERSION']
    ]) {
      const value = descriptor[key];
      const pointer = `/dataModel/${key}`;
      if (!Number.isInteger(value) || value < 0) fail(typeCode, `${key} must be a non-negative integer`, pointer, { actual: value });
      if (value > supported) fail(futureCode, `Unsupported future ${key}: ${value}`, pointer, { supported, actual: value });
    }
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
        _lastWorldWritten: null,
        _lastPhysicsPose: null,
        _lastVelocityWritten: null,
        _lastAngularVelocityWritten: undefined,
        _lastSleepingWritten: undefined
      };
      this._updateMass(body);
      this.bodies.set(entityId, body);
      return body;
    }
    getBody(entityId) { return this.bodies.get(entityId) || null; }
    destroyBody(entityId, options = {}) {
      if (!this.bodies.has(entityId)) return false;
      const endedContacts = this._removeBodyContacts(entityId);
      this.bodies.delete(entityId);
      let eventError = null;
      for (const contact of endedContacts) {
        try {
          this._emitContactEvent(this.engine?.events, contact, 'end', options.eventQueue);
        } catch (error) {
          if (!eventError) eventError = error;
        }
      }
      if (eventError) throw eventError;
      return true;
    }
    clear(options = {}) {
      let eventError = null;
      for (const id of [...this.bodies.keys()]) {
        try { this.destroyBody(id, { eventQueue: options.eventQueue }); }
        catch (error) { if (!eventError) eventError = error; }
      }
      this.contacts.clear();
      if (eventError) throw eventError;
      return this;
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
      let inheritedBodyChanged = false;
      if (phase !== 'before') inheritedBodyChanged = this._syncToECS(engine);
      if (inheritedBodyChanged) this._emitContactChanges(this._detectContacts(), engine);
      return inheritedBodyChanged;
    }
    _syncFromECS(engine) {
      const eligible = new Set();
      engine.ecs.entities.forEach(entityId => {
        const rigidbody = engine.ecs.get(entityId, 'Rigidbody') || engine.ecs.get(entityId, 'RigidBody');
        const generic = engine.ecs.get(entityId, 'Collider');
        const box2D = engine.ecs.get(entityId, 'BoxCollider2D');
        const box = engine.ecs.get(entityId, 'BoxCollider');
        const circle2D = engine.ecs.get(entityId, 'CircleCollider2D');
        const circle = engine.ecs.get(entityId, 'CircleCollider');
        if (!rigidbody && !generic && !box2D && !box && !circle2D && !circle) return;
        eligible.add(entityId);
        const transform = engine.ecs.get(entityId, 'Transform');
        const localTransform = transform || {};
        const renderable = engine.ecs.get(entityId, 'Renderable') || {};
        const colliderSources = [];
        const append = (source, forcedShape) => {
          if (!source) return;
          const entries = Array.isArray(source)
            ? source
            : (Array.isArray(source.colliders) ? source.colliders : (Array.isArray(source.shapes) ? source.shapes : [source]));
          entries.filter(Boolean).forEach(item => colliderSources.push(forcedShape && typeof item === 'object' ? { ...item, shape: forcedShape } : item));
        };
        append(generic);
        append(box2D, 'box');
        append(box, 'box');
        append(circle2D, 'circle');
        append(circle, 'circle');
        let body = this.bodies.get(entityId);
        const isNew = !body;
        if (!body) body = this.createBody(entityId, { transform: localTransform, rigidbody: rigidbody || { type: 'static' }, collider: colliderSources, renderable, managedByECS: true });
        body.managedByECS = true;
        const local = {
          x: finite(localTransform.x, 0), y: finite(localTransform.y, 0), rotation: finite(localTransform.rotation, 0),
          scaleX: finite(localTransform.scaleX, 1), scaleY: finite(localTransform.scaleY, 1)
        };
        const world = transform && Array.isArray(transform.world)
          ? transform.world
          : (engine.graph.has(entityId)
              ? engine.transform.getWorldMatrix(entityId)
              : matrix(local.x, local.y, local.rotation, local.scaleX, local.scaleY));
        if (isNew || !matricesEqual(world, body._lastWorldWritten, 1e-7)) {
          body.position.x = finite(world[4], local.x);
          body.position.y = finite(world[5], local.y);
          body.rotation = Math.atan2(world[1], world[0]) * RAD_TO_DEG;
          body.scaleX = Math.hypot(world[0], world[1]);
          body.scaleY = Math.hypot(world[2], world[3]);
          body._lastTransformWritten = local;
          body._lastWorldWritten = world.slice();
          body._lastPhysicsPose = { x: body.position.x, y: body.position.y, rotation: body.rotation };
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
    _bodyWorldMatrix(body) {
      const value = Array.isArray(body._lastWorldWritten)
        ? body._lastWorldWritten.slice()
        : matrix(body.position.x, body.position.y, body.rotation, body.scaleX, body.scaleY);
      value[4] = body.position.x;
      value[5] = body.position.y;
      const previousPose = body._lastPhysicsPose;
      if (previousPose && Math.abs(body.rotation - previousPose.rotation) > 1e-7) {
        const delta = (body.rotation - previousPose.rotation) * DEG_TO_RAD;
        const cosine = Math.cos(delta), sine = Math.sin(delta);
        const [a, b, c, d] = value;
        value[0] = cosine * a - sine * b;
        value[1] = sine * a + cosine * b;
        value[2] = cosine * c - sine * d;
        value[3] = sine * c + cosine * d;
      }
      return value;
    }
    _syncToECS(engine) {
      const entries = new Map();
      this.bodies.forEach((body, entityId) => {
        if (!body.managedByECS || !engine.ecs.entities.has(entityId)) return;
        const transform = engine.ecs.get(entityId, 'Transform');
        entries.set(entityId, {
          body,
          transform,
          desiredWorld: transform && body.type !== BODY_TYPES.STATIC
            ? this._bodyWorldMatrix(body)
            : null
        });
      });

      const resolvedWorld = new Map();
      const staged = [], stagedInheritedBodies = [];
      for (const entityId of engine.graph.traverse()) {
        const parentId = engine.graph.getParent(entityId);
        const parentWorld = parentId == null ? IDENTITY_MATRIX : resolvedWorld.get(parentId);
        const transform = engine.ecs.get(entityId, 'Transform');
        const entry = entries.get(entityId);
        let world = parentWorld;
        if (entry?.desiredWorld && transform) {
          const localMatrix = parentId == null
            ? entry.desiredWorld
            : multiply(invert(parentWorld), entry.desiredWorld);
          const rotationHint = engine.transform.getLocal(entityId).rotation;
          const local = decompose(localMatrix, { strict: true, rotationHint });
          staged.push({ entry, entityId, local });
          world = entry.desiredWorld;
        } else if (transform) {
          world = multiply(parentWorld, engine.transform.getLocalMatrix(entityId));
        }
        resolvedWorld.set(entityId, world);
        if (entry && entry.body.type === BODY_TYPES.STATIC && !matricesEqual(world, entry.body._lastWorldWritten, 1e-7)) {
          stagedInheritedBodies.push({ body: entry.body, world: world.slice() });
        }
      }

      for (const { entry, entityId, local } of staged) {
        engine.transform._applyLocal(entityId, local);
        entry.body._lastWorldWritten = entry.desiredWorld.slice();
      }

      for (const { body, world } of stagedInheritedBodies) {
        body.position.x = world[4];
        body.position.y = world[5];
        body.rotation = Math.atan2(world[1], world[0]) * RAD_TO_DEG;
        body.scaleX = Math.hypot(world[0], world[1]);
        body.scaleY = Math.hypot(world[2], world[3]);
        body._lastWorldWritten = world;
        body._lastPhysicsPose = { x: body.position.x, y: body.position.y, rotation: body.rotation };
      }

      entries.forEach(({ body, transform }, entityId) => {
        body._lastPhysicsPose = { x: body.position.x, y: body.position.y, rotation: body.rotation };
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
      return stagedInheritedBodies.length > 0;
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
      const world = this._bodyWorldMatrix(body);
      const center = {
        x: world[4] + world[0] * collider.offsetX + world[2] * collider.offsetY,
        y: world[5] + world[1] * collider.offsetX + world[3] * collider.offsetY
      };
      const columnX = Math.hypot(world[0], world[1]);
      const columnY = Math.hypot(world[2], world[3]);
      if (collider.shape === COLLIDER_SHAPES.CIRCLE) return {
        type: 'circle', center, radius: collider.radius * Math.max(columnX, columnY)
      };
      const colliderAngle = collider.rotation * DEG_TO_RAD;
      const localAxisX = { x: Math.cos(colliderAngle), y: Math.sin(colliderAngle) };
      const localAxisY = { x: -localAxisX.y, y: localAxisX.x };
      const transformedX = {
        x: world[0] * localAxisX.x + world[2] * localAxisX.y,
        y: world[1] * localAxisX.x + world[3] * localAxisX.y
      };
      const transformedY = {
        x: world[0] * localAxisY.x + world[2] * localAxisY.y,
        y: world[1] * localAxisY.x + world[3] * localAxisY.y
      };
      const axisX = normalize(transformedX);
      const handedness = cross(transformedX, transformedY) < 0 ? -1 : 1;
      const axisY = handedness < 0
        ? { x: axisX.y, y: -axisX.x }
        : { x: -axisX.y, y: axisX.x };
      return {
        type: 'box', center,
        halfX: collider.width * Math.hypot(transformedX.x, transformedX.y) * 0.5,
        halfY: collider.height * Math.hypot(transformedY.x, transformedY.y) * 0.5,
        angle: Math.atan2(axisX.y, axisX.x), axisX, axisY
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
    _emitContactEvent(events, contact, phase, eventQueue = null) {
      if (!events && !Array.isArray(eventQueue)) return;
      const triggerPhase = phase === 'start' ? 'enter' : phase === 'end' ? 'exit' : 'stay';
      const name = contact.trigger ? `physics:trigger${triggerPhase}` : `physics:collision${phase}`;
      const payload = this._eventPayload(contact, contact.trigger ? triggerPhase : phase);
      if (Array.isArray(eventQueue)) {
        eventQueue.push([name, payload], ['physics:contact', { ...payload, type: name }]);
        return;
      }
      events.emit(name, payload);
      events.emit('physics:contact', { ...payload, type: name });
    }
    _removeBodyContacts(entityId) {
      const remaining = new Map();
      const removed = [];
      this.contacts.forEach((contact, key) => {
        if (contact.bodyA.entityId === entityId || contact.bodyB.entityId === entityId) removed.push(contact);
        else remaining.set(key, contact);
      });
      this.contacts = remaining;
      return removed;
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
    destroyBody(entityId, options = {}) {
      const nativeBody = this.nativeBodies.get(entityId);
      if (nativeBody && this.world) {
        try { if (this.world.destroyBody) this.world.destroyBody(nativeBody); else this.world.DestroyBody?.(nativeBody); } catch (_) { /* Already removed. */ }
      }
      this.nativeBodies.delete(entityId);
      return super.destroyBody(entityId, options);
    }
    clear(options = {}) {
      let eventError = null;
      try { super.clear(options); } catch (error) { eventError = error; }
      if (this.world) {
        for (const nativeBody of this.nativeBodies.values()) {
          try { if (this.world.destroyBody) this.world.destroyBody(nativeBody); else this.world.DestroyBody?.(nativeBody); }
          catch (_) { /* A native adapter must not leave the Engine half-cleared. */ }
        }
      }
      this.nativeBodies.clear();
      if (eventError) throw eventError;
      return this;
    }
    sync(engine, phase = 'both') {
      if (!this.usingNative) return super.sync(engine, phase);
      this.engine = engine;
      let inheritedBodyChanged = false;
      if (phase !== 'after') {
        super.sync(engine, 'before');
        try { this.bodies.forEach(body => this._writeNativeBody(body)); } catch (error) { this._fallback(error); }
      }
      if (phase !== 'before') {
        if (this.usingNative) {
          try { this.bodies.forEach(body => this._readNativeBody(body)); } catch (error) { this._fallback(error); }
        }
        inheritedBodyChanged = super.sync(engine, 'after');
        if (inheritedBodyChanged && this.usingNative) {
          try { this.bodies.forEach(body => this._writeNativeBody(body)); } catch (error) { this._fallback(error); }
        }
      }
      return inheritedBodyChanged;
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
    _nativeFixtureGeometry(body, collider) {
      const worldShape = this._worldShape(body, collider);
      const bodyAngle = body.rotation * DEG_TO_RAD;
      const cosine = Math.cos(bodyAngle), sine = Math.sin(bodyAngle);
      const deltaX = worldShape.center.x - body.position.x;
      const deltaY = worldShape.center.y - body.position.y;
      const geometry = {
        shape: worldShape.type,
        offsetX: cosine * deltaX + sine * deltaY,
        offsetY: -sine * deltaX + cosine * deltaY
      };
      if (worldShape.type === COLLIDER_SHAPES.CIRCLE) geometry.radius = worldShape.radius;
      else {
        geometry.halfX = worldShape.halfX;
        geometry.halfY = worldShape.halfY;
        const relativeAngle = worldShape.angle - bodyAngle;
        geometry.rotation = Math.atan2(Math.sin(relativeAngle), Math.cos(relativeAngle));
      }
      return geometry;
    }
    _writeNativeBody(body) {
      let nativeBody = this.nativeBodies.get(body.entityId);
      const fixtures = body.colliders
        .filter(collider => collider.enabled)
        .map(collider => ({ collider, geometry: this._nativeFixtureGeometry(body, collider) }));
      const signatureNumber = value => Math.round(value * 1e9) / 1e9;
      const signature = JSON.stringify({
        type: body.type,
        mass: signatureNumber(body.mass),
        enabled: body.enabled,
        allowSleep: body.allowSleep,
        bullet: body.bullet,
        linearDamping: signatureNumber(body.linearDamping),
        angularDamping: signatureNumber(body.angularDamping),
        fixtures: fixtures.map(({ collider, geometry }) => ({
          id: collider.id,
          shape: geometry.shape,
          offsetX: signatureNumber(geometry.offsetX),
          offsetY: signatureNumber(geometry.offsetY),
          radius: geometry.radius == null ? null : signatureNumber(geometry.radius),
          halfX: geometry.halfX == null ? null : signatureNumber(geometry.halfX),
          halfY: geometry.halfY == null ? null : signatureNumber(geometry.halfY),
          rotation: geometry.rotation == null ? null : signatureNumber(geometry.rotation),
          friction: signatureNumber(collider.friction),
          restitution: signatureNumber(collider.restitution),
          density: signatureNumber(collider.density),
          isTrigger: collider.isTrigger,
          categoryBits: collider.categoryBits,
          maskBits: collider.maskBits,
          groupIndex: collider.groupIndex
        }))
      });
      if (nativeBody && nativeBody.__ah2dColliderSignature !== signature) {
        try { if (this.world.destroyBody) this.world.destroyBody(nativeBody); else this.world.DestroyBody?.(nativeBody); } catch (_) { /* Recreated below. */ }
        this.nativeBodies.delete(body.entityId); nativeBody = null;
      }
      if (!nativeBody) {
        const definition = {
          type: body.type, position: this._nativeVector(body.position.x / this.pixelsPerMeter, body.position.y / this.pixelsPerMeter),
          angle: body.rotation * DEG_TO_RAD, linearDamping: body.linearDamping, angularDamping: body.angularDamping,
          fixedRotation: body.fixedRotation, allowSleep: body.allowSleep, awake: !body.sleeping,
          bullet: body.bullet, active: body.enabled, enabled: body.enabled, userData: body.entityId
        };
        nativeBody = this.world.createBody ? this.world.createBody(definition) : this.world.CreateBody(definition);
        nativeBody.__ah2dColliderSignature = signature;
        nativeBody.setUserData?.(body.entityId); nativeBody.SetUserData?.(body.entityId);
        this.nativeBodies.set(body.entityId, nativeBody);
        const totalArea = fixtures.reduce((sum, fixture) => {
          const geometry = fixture.geometry;
          return sum + (geometry.shape === COLLIDER_SHAPES.CIRCLE
            ? Math.PI * geometry.radius * geometry.radius
            : geometry.halfX * geometry.halfY * 4);
        }, 0) / (this.pixelsPerMeter * this.pixelsPerMeter);
        fixtures.forEach(({ collider, geometry }) => {
          let shape;
          const offset = this._nativeVector(geometry.offsetX / this.pixelsPerMeter, geometry.offsetY / this.pixelsPerMeter);
          if (geometry.shape === COLLIDER_SHAPES.CIRCLE && this.api.Circle) {
            shape = this.api.Circle(offset, geometry.radius / this.pixelsPerMeter);
          } else if (geometry.shape === COLLIDER_SHAPES.BOX && this.api.Box) {
            shape = this.api.Box(
              geometry.halfX / this.pixelsPerMeter,
              geometry.halfY / this.pixelsPerMeter,
              offset,
              geometry.rotation
            );
          }
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
      nativeBody.setActive?.(body.enabled); nativeBody.SetActive?.(body.enabled);
      nativeBody.setEnabled?.(body.enabled); nativeBody.SetEnabled?.(body.enabled);
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
    constructor(PIXI = global.PIXI, options = {}) {
      super('pixijs');
      this.PIXI = PIXI;
      this.options = { ...options };
      delete this.options.PIXI;
      this.objects = new Map();
      this.nodes = new Map();
      this.textureLoads = new Map();
      this.app = null;
      this.world = null;
      this.ready = Promise.resolve(this);
      this.error = null;
      this._mounted = false;
      this._mountGeneration = 0;
      this._ownsApplication = !this.options.application;
      this._appendedCanvas = null;
      this.native = this._supportsNative();
      this.backend = this.native ? 'pixijs' : 'editor-bridge';
    }
    _supportsNative() {
      return Boolean(
        this.PIXI?.Container && this.PIXI?.Sprite &&
        (this.options.application || this.PIXI?.Application)
      );
    }
    _isCanvas(target) {
      return String(target?.nodeName || target?.tagName || '').toUpperCase() === 'CANVAS';
    }
    _applicationOptions(target) {
      const viewport = this.options.viewport || {};
      const targetIsCanvas = this._isCanvas(target);
      const width = finite(this.options.width ?? target?.clientWidth ?? viewport.width ?? this.options.designWidth, 0);
      const height = finite(this.options.height ?? target?.clientHeight ?? viewport.height ?? this.options.designHeight, 0);
      const output = {
        autoStart: false,
        antialias: this.options.antialias !== false,
        autoDensity: this.options.autoDensity !== false,
        backgroundAlpha: this.options.backgroundAlpha ?? 0,
        resolution: finite(this.options.resolution, global.devicePixelRatio || 1) || 1
      };
      if (width > 0) output.width = width;
      if (height > 0) output.height = height;
      if (targetIsCanvas) { output.canvas = target; output.view = target; }
      else if (target && this.options.resizeTo !== false) output.resizeTo = target;
      // AH2D owns the only frame loop. Never allow Pixi's ticker to start a
      // second simulation/render loop through nested application options.
      return { ...output, ...(this.options.applicationOptions || {}), autoStart: false };
    }
    _createApplication(target) {
      if (this.options.application) return { app: this.options.application, initialized: null };
      const applicationOptions = this._applicationOptions(target);
      const usesAsyncInit = typeof this.PIXI.Application?.prototype?.init === 'function';
      if (usesAsyncInit) {
        const app = new this.PIXI.Application();
        return { app, initialized: app.init(applicationOptions) };
      }
      return { app: new this.PIXI.Application(applicationOptions), initialized: null };
    }
    _canvas() { return this.app?.canvas || this.app?.view || null; }
    _appendCanvas() {
      const canvas = this._canvas();
      if (!canvas || this._isCanvas(this.target) || typeof this.target?.appendChild !== 'function') return;
      if (canvas.parentNode !== this.target) {
        this.target.appendChild(canvas);
        this._appendedCanvas = canvas;
      }
    }
    _finishMount(generation) {
      if (generation !== this._mountGeneration || !this.app) return this;
      const stage = this.app.stage;
      if (!stage || typeof stage.addChild !== 'function') throw new Error('PixiJS Application did not provide a usable stage');
      this.app.stop?.();
      this.app.ticker?.stop?.();
      stage.sortableChildren = true;
      this.world = new this.PIXI.Container();
      this.world.label = this.world.label || 'AH2D World';
      this.world.name = this.world.name || 'AH2D World';
      this.world.sortableChildren = true;
      stage.addChild(this.world);
      this._appendCanvas();
      this._mounted = true;
      this.error = null;
      this.native = true;
      this.backend = 'pixijs';
      this._syncScene();
      this._renderApplication();
      this.engine?.events.emit('runtime:ready', { runtime: this, engine: this.engine });
      return this;
    }
    _fallback(error, generation) {
      if (generation !== this._mountGeneration) return this;
      this.error = error;
      this._mounted = false;
      this.native = false;
      this.backend = 'editor-bridge';
      this._disposeApplication();
      this.engine?.events.emit('runtime:fallback', { runtime: this, error, engine: this.engine });
      return this;
    }
    mount(engine, target) {
      if (this._mounted && this.engine === engine && this.target === target && this.app) {
        this._syncScene();
        this._renderApplication();
        return this;
      }
      this._disposeApplication();
      super.mount(engine, target);
      this._ownsApplication = !this.options.application;
      this.native = this._supportsNative();
      this.backend = this.native ? 'pixijs' : 'editor-bridge';
      this.error = null;
      const generation = ++this._mountGeneration;
      if (!this.native) {
        this.ready = Promise.resolve(this);
        return this;
      }
      try {
        const created = this._createApplication(target);
        this.app = created.app;
        const ownsApplication = this._ownsApplication;
        if (created.initialized && typeof created.initialized.then === 'function') {
          this.ready = Promise.resolve(created.initialized)
            .then(() => {
              if (generation !== this._mountGeneration || this.app !== created.app) {
                if (ownsApplication) this._destroyPixiApplication(created.app);
                return this;
              }
              return this._finishMount(generation);
            })
            .catch(error => {
              if (generation !== this._mountGeneration || this.app !== created.app) {
                if (ownsApplication) this._destroyPixiApplication(created.app);
                return this;
              }
              return this._fallback(error, generation);
            });
        } else {
          this._finishMount(generation);
          this.ready = Promise.resolve(this);
        }
      } catch (error) {
        this._fallback(error, generation);
        this.ready = Promise.resolve(this);
      }
      return this;
    }
    _container(name) {
      const container = new this.PIXI.Container();
      container.label = container.label || name;
      container.name = container.name || name;
      container.sortableChildren = true;
      return container;
    }
    _ensureNode(id) {
      let record = this.nodes.get(id);
      if (record) return record;
      const node = this._container(`AH2D Entity ${id}`);
      const visualHost = this._container(`AH2D Visual ${id}`);
      const childrenHost = this._container(`AH2D Children ${id}`);
      visualHost.sortableChildren = false;
      node.addChild(visualHost);
      node.addChild(childrenHost);
      record = { node, visualHost, childrenHost, visual: null, visualKind: null, sourceKey: null, textureGeneration: 0 };
      this.nodes.set(id, record);
      return record;
    }
    _removeNode(id) {
      const record = this.nodes.get(id);
      if (!record) return;
      record.textureGeneration += 1;
      // Entity nodes live below their parent's childrenHost. Detach them before
      // destroying this record so deleting/reparenting a parent cannot
      // recursively destroy DisplayObjects that still exist in the ECS graph.
      for (const childNode of [...(record.childrenHost?.children || [])]) {
        record.childrenHost.removeChild?.(childNode);
        this.world?.addChild?.(childNode);
      }
      record.node.parent?.removeChild?.(record.node);
      record.node.destroy?.({ children: true, texture: false, textureSource: false, baseTexture: false });
      this.nodes.delete(id);
      this.objects.delete(id);
    }
    _setChildIndex(parent, child, index) {
      if (!parent || child.parent !== parent || typeof parent.setChildIndex !== 'function') return;
      const current = typeof parent.getChildIndex === 'function' ? parent.getChildIndex(child) : -1;
      if (current !== index) parent.setChildIndex(child, index);
    }
    _syncHierarchy(ids) {
      const live = new Set(ids);
      for (const id of [...this.nodes.keys()]) if (!live.has(id)) this._removeNode(id);
      ids.forEach(id => this._ensureNode(id));
      for (const id of ids) {
        const record = this.nodes.get(id);
        const parentId = this.engine.graph.getParent(id);
        const target = parentId == null ? this.world : this.nodes.get(parentId)?.childrenHost;
        if (target && record.node.parent !== target) target.addChild(record.node);
      }
      const roots = this.engine.graph.roots(ids);
      roots.forEach((id, index) => this._setChildIndex(this.world, this.nodes.get(id)?.node, index));
      for (const id of ids) {
        const host = this.nodes.get(id)?.childrenHost;
        this.engine.graph.getChildren(id).filter(child => live.has(child)).forEach((child, index) => {
          this._setChildIndex(host, this.nodes.get(child)?.node, index);
        });
      }
    }
    _nativeMatrix(values) {
      if (this.PIXI.Matrix) return new this.PIXI.Matrix(values[0], values[1], values[2], values[3], values[4], values[5]);
      return { a: values[0], b: values[1], c: values[2], d: values[3], tx: values[4], ty: values[5] };
    }
    _applyMatrix(displayObject, values, fallbackTransform = null) {
      const nativeMatrix = this._nativeMatrix(values);
      if (typeof displayObject.setFromMatrix === 'function') displayObject.setFromMatrix(nativeMatrix);
      else if (typeof displayObject.transform?.setFromMatrix === 'function') displayObject.transform.setFromMatrix(nativeMatrix);
      else {
        const local = fallbackTransform || decompose(values, { strict: false });
        if (displayObject.position?.set) displayObject.position.set(local.x, local.y);
        else { displayObject.x = local.x; displayObject.y = local.y; }
        displayObject.rotation = finite(local.rotation, 0) * DEG_TO_RAD;
        if (displayObject.scale?.set) displayObject.scale.set(finite(local.scaleX, 1), finite(local.scaleY, 1));
        else { displayObject.scaleX = finite(local.scaleX, 1); displayObject.scaleY = finite(local.scaleY, 1); }
      }
    }
    _localFromWorld(id) {
      const world = this.engine.transform.getWorldMatrix(id);
      const parentId = this.engine.graph.getParent(id);
      if (parentId == null) return world;
      try { return multiply(invert(this.engine.transform.getWorldMatrix(parentId)), world); }
      catch (_) { return this.engine.transform.getLocalMatrix(id); }
    }
    _color(value, fallback = 0xffffff) {
      if (value == null || value === '') return fallback;
      if (Number.isFinite(Number(value))) return Number(value);
      const source = String(value).trim();
      if (/^#[0-9a-f]{3}$/i.test(source)) return Number.parseInt(source.slice(1).split('').map(part => part + part).join(''), 16);
      if (/^#[0-9a-f]{6}$/i.test(source)) return Number.parseInt(source.slice(1), 16);
      try {
        const color = this.PIXI.Color ? new this.PIXI.Color(source) : null;
        return color?.toNumber?.() ?? color?.toNumber ?? source;
      } catch (_) { return fallback; }
    }
    _whiteTexture() { return this.PIXI.Texture?.WHITE || this.PIXI.Texture?.EMPTY || null; }
    _assetSource(assetId) {
      if (!assetId || !this.engine?.document?.assets) return null;
      if (this._assetDocument !== this.engine.document) {
        this._assetDocument = this.engine.document;
        this._assetIndex = new Map();
        const stack = [this.engine.document.assets], seen = new Set();
        while (stack.length) {
          const value = stack.pop();
          if (!value || typeof value !== 'object' || seen.has(value)) continue;
          seen.add(value);
          if (!Array.isArray(value) && value.id != null) {
            const source = value.imageSrc ?? value.src ?? value.url ?? value.dataUrl ?? value.dataURI;
            if (source != null && source !== '') this._assetIndex.set(String(value.id), source);
          }
          if (Array.isArray(value)) value.forEach(item => stack.push(item));
          else Object.values(value).forEach(item => { if (item && typeof item === 'object') stack.push(item); });
        }
      }
      return this._assetIndex.get(String(assetId)) ?? null;
    }
    _textureSource(renderable) {
      const source = renderable.imageSrc || this._assetSource(renderable.assetId) || renderable.assetId || null;
      return {
        key: `${renderable.assetId || ''}|${source == null ? '' : String(source)}`,
        source,
        hasTexture: source != null && source !== ''
      };
    }
    _resolveTexture(renderable, id, source) {
      const assets = this.PIXI.Assets;
      const cached = (renderable.assetId && assets?.get?.(renderable.assetId)) ||
        (source != null && source !== '' && assets?.get?.(source));
      let resolved;
      if (this.options.textureResolver) resolved = this.options.textureResolver(renderable, id, this.engine, this.PIXI);
      else if (cached) resolved = cached;
      else if (source != null && source !== '' && this.options.loadAssets !== false && assets?.load) {
        if (!this.textureLoads.has(source)) {
          const loading = assets.load(source);
          this.textureLoads.set(source, loading);
          if (loading && typeof loading.then === 'function') {
            Promise.resolve(loading).catch(() => {
              if (this.textureLoads.get(source) === loading) this.textureLoads.delete(source);
            });
          }
        }
        resolved = this.textureLoads.get(source);
      } else resolved = source;
      if (resolved == null || resolved === '') return this._whiteTexture();
      if (typeof resolved === 'string' && this.PIXI.Texture?.from) return this.PIXI.Texture.from(resolved);
      return resolved;
    }
    _createSprite(texture) {
      try { return new this.PIXI.Sprite(texture || this._whiteTexture()); }
      catch (_) { return new this.PIXI.Sprite({ texture: texture || this._whiteTexture() }); }
    }
    _destroyVisual(record) {
      if (!record.visual) return;
      record.visualHost.removeChild?.(record.visual);
      record.visual.destroy?.({ texture: false, textureSource: false, baseTexture: false });
      record.visual = null;
      record.visualKind = null;
      record.textureGeneration += 1;
    }
    _createVisual(record, kind) {
      if (record.visual && record.visualKind === kind) return record.visual;
      this._destroyVisual(record);
      record.visual = kind === 'graphics'
        ? new this.PIXI.Graphics()
        : this._createSprite(this._whiteTexture());
      record.visualKind = kind;
      record.visualHost.addChild(record.visual);
      return record.visual;
    }
    _setTexture(record, renderable, id) {
      const { key, source, hasTexture } = this._textureSource(renderable);
      if (record.sourceKey === key && record.visual) return;
      record.sourceKey = key;
      record.textureGeneration += 1;
      if (!hasTexture && this.PIXI.Graphics) {
        this._createVisual(record, 'graphics');
        this.objects.set(id, record.visual);
        return;
      }
      let resolved;
      try { resolved = this._resolveTexture(renderable, id, source); }
      catch (error) {
        resolved = this._whiteTexture();
        this.engine.events.emit('runtime:textureError', { runtime: this, entityId: id, source, error, engine: this.engine });
      }
      this._createVisual(record, 'sprite');
      this.objects.set(id, record.visual);
      const textureGeneration = ++record.textureGeneration;
      if (resolved && typeof resolved.then === 'function') {
        record.visual.texture = this._whiteTexture();
        Promise.resolve(resolved).then(texture => {
          if (this.nodes.get(id) !== record || record.textureGeneration !== textureGeneration || record.sourceKey !== key) return;
          record.visual.texture = typeof texture === 'string' && this.PIXI.Texture?.from ? this.PIXI.Texture.from(texture) : (texture || this._whiteTexture());
          this._renderApplication();
        }).catch(error => {
          if (this.nodes.get(id) === record && record.textureGeneration === textureGeneration) {
            this.engine.events.emit('runtime:textureError', { runtime: this, entityId: id, source, error, engine: this.engine });
          }
        });
      } else record.visual.texture = resolved || this._whiteTexture();
    }
    _drawGraphics(graphics, width, height, color, anchorX = 0.5, anchorY = 0.5) {
      graphics.clear?.();
      const x = -width * anchorX, y = -height * anchorY;
      if (typeof graphics.rect === 'function' && typeof graphics.fill === 'function') {
        graphics.rect(x, y, width, height).fill(color);
      } else {
        graphics.beginFill?.(color);
        graphics.drawRect?.(x, y, width, height);
        graphics.endFill?.();
      }
    }
    _syncRenderable(id, record) {
      const renderable = this.engine.ecs.get(id, 'Renderable');
      if (!renderable) {
        if (record.visual) {
          this._destroyVisual(record);
          record.sourceKey = null;
          this.objects.delete(id);
        }
        record.node.visible = !this.engine.ecs.has(id, 'Hidden');
        record.node.zIndex = 0;
        return;
      }
      this._setTexture(record, renderable, id);
      const visual = record.visual;
      const anchor = renderable.anchor;
      const anchorX = finite(renderable.anchorX ?? (Array.isArray(anchor) ? anchor[0] : anchor?.x), finite(this.options.defaultAnchor, 0.5));
      const anchorY = finite(renderable.anchorY ?? (Array.isArray(anchor) ? anchor[1] : anchor?.y), finite(this.options.defaultAnchor, 0.5));
      visual.anchor?.set?.(anchorX, anchorY);
      const width = finite(renderable.width, 64);
      const height = finite(renderable.height, 64);
      const color = this._color(renderable.tint ?? renderable.color, 0xffffff);
      if (record.visualKind === 'graphics') this._drawGraphics(visual, width, height, color, anchorX, anchorY);
      else {
        if (width >= 0) visual.width = width;
        if (height >= 0) visual.height = height;
        visual.tint = color;
      }
      visual.alpha = clamp(finite(renderable.alpha ?? renderable.opacity, 1), 0, 1);
      visual.blendMode = renderable.blendMode ?? 'normal';
      record.node.visible = !(this.engine.ecs.has(id, 'Hidden') || renderable.visible === false);
      record.node.alpha = 1;
      record.node.zIndex = finite(renderable.zIndex ?? renderable.zOrder ?? renderable.layer, 0);
    }
    _rendererSize() {
      const renderer = this.app?.renderer;
      const screen = this.app?.screen || renderer?.screen;
      return {
        width: finite(screen?.width ?? renderer?.width ?? this.target?.clientWidth ?? this.options.width, 0),
        height: finite(screen?.height ?? renderer?.height ?? this.target?.clientHeight ?? this.options.height, 0)
      };
    }
    _resizeRenderer() {
      if (this.options.resizeTo === false || this._isCanvas(this.target)) return;
      const width = finite(this.target?.clientWidth, 0), height = finite(this.target?.clientHeight, 0);
      const current = this._rendererSize();
      if (width > 0 && height > 0 && (Math.abs(current.width - width) > 0.5 || Math.abs(current.height - height) > 0.5)) {
        this.app?.renderer?.resize?.(width, height);
      }
    }
    _activeCamera() {
      const explicit = this.engine.camera.active;
      if (explicit && this.engine.ecs.has(explicit, 'Camera')) return explicit;
      return this.engine.ecs.query('Camera').find(id => this.engine.ecs.get(id, 'Camera')?.active === true) || null;
    }
    _syncViewport() {
      this._resizeRenderer();
      const size = this._rendererSize();
      const cameraId = this._activeCamera();
      const camera = cameraId ? this.engine.ecs.get(cameraId, 'Camera') : null;
      const configured = this.options.viewport || {};
      const logicalWidth = finite(
        camera?.viewportWidth ?? configured.width ?? this.options.viewportWidth ?? this.options.designWidth,
        size.width
      ) || size.width || 1;
      const logicalHeight = finite(
        camera?.viewportHeight ?? configured.height ?? this.options.viewportHeight ?? this.options.designHeight,
        size.height
      ) || size.height || 1;
      const hasDesignViewport = Boolean(
        this.options.viewport || this.options.viewportWidth || this.options.viewportHeight ||
        this.options.designWidth || this.options.designHeight
      );
      const fit = camera?.fit || configured.fit || this.options.fit || (hasDesignViewport ? 'contain' : 'none');
      let fitX = 1, fitY = 1;
      if (size.width > 0 && size.height > 0 && logicalWidth > 0 && logicalHeight > 0) {
        if (fit === 'stretch') { fitX = size.width / logicalWidth; fitY = size.height / logicalHeight; }
        else if (fit === 'contain' || fit === 'cover') {
          const scale = fit === 'cover'
            ? Math.max(size.width / logicalWidth, size.height / logicalHeight)
            : Math.min(size.width / logicalWidth, size.height / logicalHeight);
          fitX = scale; fitY = scale;
        }
      }
      const offsetX = (size.width - logicalWidth * fitX) / 2;
      const offsetY = (size.height - logicalHeight * fitY) / 2;
      let view = [fitX, 0, 0, fitY, offsetX, offsetY];
      if (cameraId) {
        const zoom = finite(camera?.zoom, 1) || 1;
        const cameraWorld = this.engine.transform.getWorldMatrix(cameraId);
        const logicalView = multiply(matrix(logicalWidth / 2, logicalHeight / 2, 0, zoom, zoom), invert(cameraWorld));
        view = multiply(view, logicalView);
      }
      this._applyMatrix(this.world, view);
      const clearColor = camera?.clearColor ?? this.options.clearColor;
      const renderer = this.app?.renderer;
      if (clearColor != null) {
        const color = this._color(clearColor, 0x000000);
        if (renderer?.background) renderer.background.color = color;
        else if (renderer) renderer.backgroundColor = color;
      }
    }
    _syncScene() {
      if (!this._mounted || !this.engine || !this.world) return false;
      this.engine.transform.update();
      const ids = this.engine.graph.traverse();
      this._syncHierarchy(ids);
      for (const id of ids) {
        const record = this.nodes.get(id);
        const transform = this.engine.ecs.get(id, 'Transform');
        this._applyMatrix(record.node, this._localFromWorld(id), transform);
        this._syncRenderable(id, record);
      }
      this._syncViewport();
      return true;
    }
    _renderApplication() {
      if (!this._mounted || !this.app) return false;
      if (typeof this.app.render === 'function') this.app.render();
      else if (typeof this.app.renderer?.render === 'function') {
        try { this.app.renderer.render(this.app.stage); }
        catch (_) { this.app.renderer.render({ container: this.app.stage }); }
      }
      return true;
    }
    render() {
      if (!this._syncScene()) return false;
      return this._renderApplication();
    }
    resize(width, height) {
      this.app?.renderer?.resize?.(finite(width, 0), finite(height, 0));
      if (this._mounted) { this._syncViewport(); this._renderApplication(); }
      return this;
    }
    _destroyPixiApplication(app) {
      if (!app) return;
      const canvas = app.canvas || app.view || null;
      try { app.destroy?.(true, { children: true, texture: false, textureSource: false, baseTexture: false }); }
      catch (_) { try { app.destroy?.({ removeView: true }, { children: true, texture: false, textureSource: false, baseTexture: false }); } catch (_) { /* Best-effort across Pixi versions. */ } }
      if (canvas?.parentNode && typeof canvas.parentNode.removeChild === 'function') canvas.parentNode.removeChild(canvas);
    }
    _disposeApplication() {
      this._mounted = false;
      for (const id of [...this.nodes.keys()]) this._removeNode(id);
      if (this.world) {
        this.world.parent?.removeChild?.(this.world);
        this.world.destroy?.({ children: true, texture: false, textureSource: false, baseTexture: false });
      }
      const app = this.app;
      const appendedCanvas = this._appendedCanvas;
      this.world = null;
      this.app = null;
      this._appendedCanvas = null;
      this.objects.clear();
      this.nodes.clear();
      this.textureLoads.clear();
      this._assetDocument = null;
      this._assetIndex = null;
      if (app && this._ownsApplication) this._destroyPixiApplication(app);
      else if (appendedCanvas?.parentNode && typeof appendedCanvas.parentNode.removeChild === 'function') appendedCanvas.parentNode.removeChild(appendedCanvas);
    }
    unmount() {
      ++this._mountGeneration;
      this._disposeApplication();
      this.ready = Promise.resolve(this);
      return this;
    }
    destroy() {
      this.unmount();
      this.error = null;
      super.destroy();
      return this;
    }
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
      this._destroyInProgress = false;
      if (options.entityCodec instanceof DataModel.EntityCodec) {
        this.entityCodec = options.entityCodec;
        this.componentSchemas = options.entityCodec.registry;
      } else {
        this.componentSchemas = options.componentSchemas instanceof DataModel.ComponentSchemaRegistry
          ? options.componentSchemas
          : DataModel.createDefaultComponentRegistry();
        this.entityCodec = new DataModel.EntityCodec(this.componentSchemas);
      }
      this.schemas = this.componentSchemas;
      this.ecs = new ECS(this.events, this.componentSchemas);
      this.graph = new SceneGraph(this.events);
      this.transform = new TransformSystem(this);
      this.graph.bindTransformSystem(this.transform);
      this.graph.bindEntityStore(id => this.ecs.entities.has(id));
      this.ecs.bindDestroyGuard(id => {
        if (!this.graph.has(id)) return;
        const children = this.graph.getChildren(id);
        if (children.length) {
          throw graphError('E_GRAPH_HAS_CHILDREN', 'Cannot destroy ' + id + ' through low-level ECS while it has children', {
            id, children
          });
        }
        throw graphError('E_GRAPH_LIFECYCLE', 'Use Engine.destroyEntity() for an ECS-backed Scene Graph Entity', { id });
      });
      this.events.on('entity:create', id => this.graph.add(id));
      this.events.on('entity:createRollback', id => {
        if (this.graph.has(id)) this.graph.remove(id, { childPolicy: 'detach', [GRAPH_INTERNAL]: true });
      });
      this.events.on('entity:destroy', id => {
        this.physics?.destroyBody(id);
        this.transform.forget(id);
      });
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
    registerComponent(definition) {
      this.componentSchemas.register(definition);
      return this.componentSchemas.describe(definition.type);
    }
    useRuntime(type, options = {}) {
      const target = this.runtimeTarget;
      this.runtime?.destroy();
      if (type instanceof RuntimeAdapter) this.runtime = type;
      else if (type === 'pixijs') this.runtime = new PixiRuntimeAdapter(options.PIXI, options);
      else if (type === 'phaserjs') this.runtime = new PhaserRuntimeAdapter(options.Phaser);
      else this.runtime = new CustomRuntimeAdapter(options);
      if (this.running && target) this.runtime.mount(this, target);
      this.events.emit('runtime:change', { runtime: this.runtime, name: this.runtime.name });
      return this.runtime;
    }
    _decodeEntity(data = {}) {
      const input = data === undefined ? {} : data;
      const source = isPlainObject(input) && (!Object.prototype.hasOwnProperty.call(input, 'id') || input.id == null)
        ? { ...input, id: uid() }
        : input;
      return this.entityCodec.decodeToRuntime(source, { profile: DataModel.PROFILES.RUNTIME });
    }
    createEntity(data = {}) {
      const decoded = this._decodeEntity(data);
      if (this.ecs.entities.has(decoded.id)) throw new DataModel.ComponentSchemaError('E_ENTITY_EXISTS', `Entity already exists: ${decoded.id}`);
      if (decoded.parentId != null && decoded.parentId !== decoded.id && !this.graph.has(decoded.parentId)) {
        throw new DataModel.ComponentSchemaError('E_DANGLING_PARENT', `Parent does not exist in this Scene: ${decoded.parentId}`, {
          details: { entityId: decoded.id, parentId: decoded.parentId }
        });
      }
      if (decoded.id === decoded.parentId) {
        throw graphError('E_GRAPH_CYCLE', 'SceneGraph cycle detected while parenting ' + decoded.id + ' to itself', {
          child: decoded.id, parent: decoded.parentId
        });
      }
      let id = null;
      try {
        id = this.ecs.create(decoded.id);
        Object.entries(decoded.components).forEach(([type, value]) => this.ecs.add(id, type, clone(value)));
        this.graph.attach(id, decoded.parentId);
      } catch (error) {
        const rollbackId = id || decoded.id;
        if (this.graph.has(rollbackId)) this.graph.remove(rollbackId, { childPolicy: 'detach', [GRAPH_INTERNAL]: true });
        this.ecs.entities.delete(rollbackId);
        this.ecs.components.forEach(store => store.delete(rollbackId));
        this.transform.forget(rollbackId);
        throw error;
      }
      if (decoded.conflicts.length) {
        this.events.emit('component:conflict', { entityId: id, conflicts: clone(decoded.conflicts) });
      }
      this.transform.update();
      return id;
    }
    reparent(childId, parentId = null, options = {}) {
      this.graph.attach(childId, parentId, options);
      this.transform.update();
      return childId;
    }
    destroyEntity(id, options = {}) {
      if (this._destroyInProgress) {
        throw graphError('E_ENTITY_DESTROY_REENTRY', 'Nested Entity destruction is not allowed during an active destroy transaction', { id });
      }
      if (!this.ecs.entities.has(id)) return [];
      if (typeof options === 'string') options = { childPolicy: options };
      this._destroyInProgress = true;
      try {
        const graphEvents = [], physicsEvents = [];
        const removed = this.graph.remove(id, {
          ...options,
          [GRAPH_INTERNAL]: true,
          eventQueue: graphEvents,
          beforeCommit: entityIds => {
            for (const entityId of entityIds) this.events.emit('entity:beforeDestroy', entityId);
          }
        });

        let eventError = null;
        const retainFirstError = error => { if (!eventError) eventError = error; };
        for (const entityId of removed) {
          try { this.ecs.destroy(entityId, { [GRAPH_INTERNAL]: true, emit: false }); } catch (error) { retainFirstError(error); }
          try { this.physics?.destroyBody(entityId, { eventQueue: physicsEvents }); } catch (error) { retainFirstError(error); }
          try { this.transform.forget(entityId); } catch (error) { retainFirstError(error); }
        }
        try { this.transform.update(); } catch (error) { retainFirstError(error); }

        const emitCommitted = (type, payload) => {
          try { this.events.emit(type, payload); } catch (error) { retainFirstError(error); }
        };
        for (const [type, payload] of graphEvents) emitCommitted(type, payload);
        for (const [type, payload] of physicsEvents) emitCommitted(type, payload);
        for (const entityId of removed) emitCommitted('entity:destroy', entityId);
        emitCommitted('entity:destroyTree', {
          rootId: id,
          entities: removed.slice(),
          childPolicy: options.childPolicy || options.children || options.mode || 'reject',
          engine: this
        });
        if (eventError) throw eventError;
        return removed;
      } finally {
        this._destroyInProgress = false;
      }
    }
    load(document, options = {}) {
      if (typeof options === 'string') options = { sceneId: options };
      if (!isPlainObject(document)) {
        throw new DataModel.ComponentSchemaError('E_DOCUMENT_TYPE', 'Project document must be a plain object');
      }
      const source = document;
      assertDataModelCompatibility(source);
      const scenes = Array.isArray(source.scenes) ? source.scenes : [];
      const requestedSceneId = options.sceneId || source.currentSceneId || source.meta?.currentSceneId || null;
      const activeScene = scenes.length
        ? (scenes.find(scene => scene?.id === requestedSceneId) || (options.sceneId ? null : scenes[0]))
        : null;
      if (options.sceneId && scenes.length && !activeScene) throw new Error(`Unknown Scene: ${options.sceneId}`);
      const entities = activeScene
        ? (Array.isArray(activeScene.objects) ? activeScene.objects : (Array.isArray(activeScene.scene) ? activeScene.scene : []))
        : (Array.isArray(source.scene) ? source.scene : (Array.isArray(source.entities) ? source.entities : []));
      const nextDocument = clone(source);
      if (activeScene) {
        nextDocument.currentSceneId = activeScene.id;
        if (nextDocument.meta && typeof nextDocument.meta === 'object') nextDocument.meta.currentSceneId = activeScene.id;
      }
      const stagedPostProcess = new PostProcessSystem(null);
      stagedPostProcess.load(source.postProcess);
      const nextPostProcess = stagedPostProcess.toJSON();
      const stagedEvents = new EventBus();
      const stagedEcs = new ECS(stagedEvents, this.componentSchemas);
      const stagedGraph = new SceneGraph(stagedEvents);
      stagedGraph.bindEntityStore(id => stagedEcs.entities.has(id));
      stagedEvents.on('entity:create', id => stagedGraph.add(id));
      const decodedEntities = entities.map(entity => this._decodeEntity(entity));
      const nextActiveScene = activeScene && Array.isArray(nextDocument.scenes)
        ? nextDocument.scenes[scenes.indexOf(activeScene)]
        : null;
      const nextEntities = nextActiveScene
        ? (Array.isArray(activeScene.objects) ? nextActiveScene.objects : nextActiveScene.scene)
        : (Array.isArray(source.scene) ? nextDocument.scene : nextDocument.entities);
      if (Array.isArray(nextEntities)) {
        decodedEntities.forEach((decoded, index) => {
          const entity = nextEntities[index];
          if (entity && typeof entity === 'object' && (!Object.prototype.hasOwnProperty.call(entity, 'id') || entity.id == null)) entity.id = decoded.id;
        });
      }
      if (nextActiveScene) nextDocument.scene = Array.isArray(nextEntities) ? clone(nextEntities) : [];
      const stagedIds = new Set(decodedEntities.map(entity => entity.id));
      const dangling = decodedEntities.find(entity => entity.parentId != null && !stagedIds.has(entity.parentId));
      if (dangling) {
        throw new DataModel.ComponentSchemaError('E_DANGLING_PARENT', `Parent does not exist in this Scene: ${dangling.parentId}`, {
          details: { entityId: dangling.id, parentId: dangling.parentId }
        });
      }
      decodedEntities.forEach(decoded => {
        stagedEcs.create(decoded.id);
        Object.entries(decoded.components).forEach(([type, value]) => stagedEcs.add(decoded.id, type, value));
      });

      const disjointParent = new Map(decodedEntities.map(decoded => [decoded.id, decoded.id]));
      const disjointRank = new Map(decodedEntities.map(decoded => [decoded.id, 0]));
      const findRoot = id => {
        let root = id;
        while (disjointParent.get(root) !== root) root = disjointParent.get(root);
        let current = id;
        while (disjointParent.get(current) !== current) {
          const next = disjointParent.get(current);
          disjointParent.set(current, root);
          current = next;
        }
        return root;
      };
      decodedEntities.forEach(decoded => {
        if (decoded.parentId == null) return;
        const childRoot = findRoot(decoded.id);
        const parentRoot = findRoot(decoded.parentId);
        if (childRoot === parentRoot) {
          throw graphError('E_GRAPH_CYCLE', 'SceneGraph cycle detected while parenting ' + decoded.id + ' to ' + decoded.parentId, {
            child: decoded.id, parent: decoded.parentId
          });
        }
        const childRank = disjointRank.get(childRoot);
        const parentRank = disjointRank.get(parentRoot);
        if (childRank < parentRank) disjointParent.set(childRoot, parentRoot);
        else if (childRank > parentRank) disjointParent.set(parentRoot, childRoot);
        else {
          disjointParent.set(parentRoot, childRoot);
          disjointRank.set(childRoot, childRank + 1);
        }
      });
      decodedEntities.forEach(decoded => stagedGraph._setParent(decoded.id, decoded.parentId));

      const physicsEvents = [];
      let eventError = null;
      const retainFirstError = error => { if (!eventError) eventError = error; };
      try { this.physics.clear({ eventQueue: physicsEvents }); } catch (error) { retainFirstError(error); }
      this.ecs.clear(); this.graph.clear({ [GRAPH_INTERNAL]: true });
      stagedEcs.entities.forEach(id => this.ecs.entities.add(id));
      stagedEcs.components.forEach((store, type) => this.ecs.components.set(type, store));
      stagedGraph.nodes.forEach(id => this.graph.nodes.add(id));
      stagedGraph.parent.forEach((parent, child) => this.graph.parent.set(child, parent));
      stagedGraph.children.forEach((children, id) => this.graph.children.set(id, children));
      this.document = nextDocument;
      this.activeSceneId = activeScene?.id || null;
      this.postProcess.load(nextPostProcess, { emit: false });
      const transformedEntities = this.transform.update(false, { emit: false });
      const emitCommitted = (type, payload) => {
        try { this.events.emit(type, payload); } catch (error) { retainFirstError(error); }
      };
      for (const [type, payload] of physicsEvents) emitCommitted(type, payload);
      emitCommitted('postprocess:change', { postProcess: this.postProcess, engine: this });
      decodedEntities.forEach(decoded => {
        emitCommitted('entity:create', decoded.id);
        emitCommitted('graph:attach', { child: decoded.id, parent: decoded.parentId });
        if (decoded.conflicts.length) emitCommitted('component:conflict', { entityId: decoded.id, conflicts: clone(decoded.conflicts) });
      });
      if (transformedEntities.length) emitCommitted('transform:update', { entities: transformedEntities.slice(), engine: this });
      emitCommitted('document:load', source);
      if (activeScene) emitCommitted('scene:change', { id: activeScene.id, name: activeScene.name || 'Scene', scene: activeScene, engine: this });
      if (eventError) throw eventError;
      return this;
    }
    loadScene(sceneId) {
      if (!this.document) throw new Error('Load a project before switching Scene');
      return this.load(this.document, { sceneId });
    }
    export() {
      return {
        format: 'AH2D', version: 3, engine: VERSION,
        dataModel: {
          id: DataModel.DATA_MODEL_ID,
          version: DataModel.DATA_MODEL_VERSION,
          componentSchemaVersion: DataModel.COMPONENT_SCHEMA_VERSION
        },
        postProcess: this.postProcess.toJSON(),
        entities: [...this.ecs.entities].map(id => ({
          id,
          name: this.ecs.get(id, 'Name')?.value,
          parentId: this.graph.getParent(id),
          components: Object.fromEntries(
            [...this.ecs.components]
              .filter(([, store]) => store.has(id))
              .map(([type, store]) => [type, this.componentSchemas.normalize(type, store.get(id), {
                profile: DataModel.PROFILES.SNAPSHOT,
                filterRuntimeOnly: false
              })])
          )
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
        document: clone(this.document || this.export()),
        runtime: clone(this.export()),
        physics: clone(this.physics.snapshot()),
        animationTime: this.animation.time,
        activeCamera: this.camera.active,
        activeSceneId: this.activeSceneId
      };
    }
    restoreSnapshot(snapshot = this.playSnapshot) {
      if (!snapshot) return false;
      const runtime = snapshot.runtime || snapshot.document || snapshot;
      const authoringDocument = snapshot.runtime && snapshot.document ? clone(snapshot.document) : null;
      this.load(clone(runtime));
      if (authoringDocument) {
        this.document = authoringDocument;
        this.activeSceneId = snapshot.activeSceneId || authoringDocument.currentSceneId || null;
      }
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
      try {
        const dt = Math.min(0.05, (time - this.lastTime) / 1000 || 0);
        this.lastTime = time;
        this.update(dt);
        if (!this.running) return;
        this.runtime?.render(1);
        if (this.running) this.frameHandle = this._requestFrame(this.frame);
      } catch (error) {
        this.running = false;
        this.frameHandle = null;
        try { this.runtime?.unmount?.(); } catch (_) { /* Preserve the frame error. */ }
        try { this.events.emit('runtime:error', { runtime: this.runtime, error, engine: this }); } catch (_) { /* Preserve the frame error. */ }
      }
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
      let stopError = null;
      const retainError = error => { if (!stopError) stopError = error; };
      try { if (shouldRestore && this.playSnapshot) this.restoreSnapshot(this.playSnapshot); } catch (error) { retainError(error); }
      try { this.runtime?.unmount?.(); } catch (error) { retainError(error); }
      try {
        this.events.emit('runtime:stop', { restored: Boolean(shouldRestore && this.playSnapshot), wasRunning, engine: this });
      } catch (error) { retainError(error); }
      if (!options.keepSnapshot) this.playSnapshot = null;
      if (stopError) throw stopError;
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
    VERSION, Engine, EventBus, ECS, SceneGraph, TransformSystem, Matrix2D, CameraSystem,
    DataModel,
    ComponentSchemaRegistry: DataModel.ComponentSchemaRegistry,
    EntityCodec: DataModel.EntityCodec,
    createDefaultComponentRegistry: DataModel.createDefaultComponentRegistry,
    createDefaultEntityCodec: DataModel.createDefaultEntityCodec,
    LightingSystem, ShadowSystem, AnimationSystem, PostProcessSystem, TilemapSystem,
    DEFAULT_POST_PROCESS_EFFECTS, createDefaultPostProcess,
    BODY_TYPES, COLLIDER_SHAPES, PhysicsAdapter, Box2DPhysicsAdapter,
    RuntimeAdapter, PixiRuntimeAdapter, PhaserRuntimeAdapter, CustomRuntimeAdapter,
    EditorBridge
  });
})(window);
