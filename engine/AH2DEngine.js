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
    constructor(engine) {
      this.engine = engine;
      this.time = 0;
      this.clips = new Map();
      this.names = new Map();
    }
    load(source) {
      const animations = Array.isArray(source) ? source : (Array.isArray(source?.animations) ? source.animations : []);
      this.clips.clear();
      this.names.clear();
      DataModel.normalizeAnimationClips(animations).forEach(clip => {
        if (!this.clips.has(clip.id)) this.clips.set(clip.id, clip);
        const name = String(clip.name || '').trim().toLocaleLowerCase();
        if (name) {
          const matches = this.names.get(name) || [];
          matches.push(clip);
          this.names.set(name, matches);
        }
      });
      this.time = 0;
      return this;
    }
    resolve(reference) {
      const key = String(reference == null ? '' : reference).trim();
      if (!key) return null;
      if (this.clips.has(key)) return this.clips.get(key);
      const matches = this.names.get(key.toLocaleLowerCase()) || [];
      return matches.length === 1 ? matches[0] : null;
    }
    getClip(reference) {
      const clip = this.resolve(reference);
      return clip ? clone(clip) : null;
    }
    _component(entityId, create = false) {
      if (!this.engine.ecs.entities.has(entityId)) throw new Error(`Unknown Entity: ${entityId}`);
      let animation = this.engine.ecs.get(entityId, 'Animation');
      if (!animation && create) {
        this.engine.ecs.add(entityId, 'Animation', {});
        animation = this.engine.ecs.get(entityId, 'Animation');
      }
      return animation || null;
    }
    _clipFor(animation) {
      return this.resolve(animation?.clipId || animation?.clip);
    }
    play(entityId, clipReference, options = {}) {
      if (clipReference && typeof clipReference === 'object') { options = clipReference; clipReference = null; }
      const animation = this._component(entityId, true);
      if (clipReference != null) {
        const clip = this.resolve(clipReference);
        if (!clip) throw new Error(`Unknown Animation Clip: ${clipReference}`);
        animation.clipId = clip.id;
      }
      const clip = this._clipFor(animation);
      if (!clip && !finite(animation.duration, 0)) throw new Error(`Unknown Animation Clip: ${animation.clipId || animation.clip || '(none)'}`);
      if (options.fromStart || animation.completed) animation.time = options.reverse ? (clip ? clip.frameCount / clip.fps : finite(animation.duration, 0)) : 0;
      if (options.frame != null && clip) animation.time = finite(options.frame, 0) / clip.fps;
      else if (options.time != null) animation.time = Math.max(0, finite(options.time, 0));
      if (options.speed != null) animation.speed = finite(options.speed, 1);
      if (options.loop != null) animation.loop = Boolean(options.loop);
      animation.playing = true;
      animation.completed = false;
      this._apply(entityId, animation, clip, { emitSample: true });
      this.engine.events.emit('animation:play', { entityId, clipId: clip?.id || null, animation, engine: this.engine });
      return animation;
    }
    pause(entityId) {
      const animation = this._component(entityId);
      if (!animation) return false;
      animation.playing = false;
      this.engine.events.emit('animation:pause', { entityId, clipId: this._clipFor(animation)?.id || null, animation, engine: this.engine });
      return true;
    }
    stop(entityId, options = {}) {
      const animation = this._component(entityId);
      if (!animation) return false;
      const clip = this._clipFor(animation);
      animation.playing = false;
      animation.completed = false;
      animation.time = options.reset === false ? Math.max(0, finite(animation.time, 0)) : 0;
      this._apply(entityId, animation, clip, { emitSample: true });
      this.engine.events.emit('animation:stop', { entityId, clipId: clip?.id || null, animation, engine: this.engine });
      return true;
    }
    seek(entityId, timeOrFrame, options = {}) {
      const animation = this._component(entityId, true);
      const clip = this._clipFor(animation);
      if (!clip) throw new Error(`Unknown Animation Clip: ${animation.clipId || animation.clip || '(none)'}`);
      const previous = Math.max(0, finite(animation.time, 0));
      const next = options.unit === 'frame' ? finite(timeOrFrame, 0) / clip.fps : finite(timeOrFrame, 0);
      const duration = clip.frameCount / clip.fps;
      const loop = options.loop == null ? (typeof animation.loop === 'boolean' ? animation.loop : clip.loop) : Boolean(options.loop);
      animation.time = loop ? this._mod(next, duration) : clamp(next, 0, duration);
      animation.completed = false;
      const sample = this._apply(entityId, animation, clip, { emitSample: true });
      if (options.emitEvents) this._emitEvents(entityId, animation, clip, previous, loop ? next : animation.time, loop);
      this.engine.events.emit('animation:seek', { entityId, clipId: clip.id, time: animation.time, frame: animation.frame, animation, engine: this.engine });
      return sample;
    }
    setFrame(entityId, frame, options = {}) {
      return this.seek(entityId, frame, { ...options, unit: 'frame' });
    }
    sample(entityId, time = null, options = {}) {
      const animation = this._component(entityId);
      if (!animation) return null;
      const clip = this._clipFor(animation);
      if (!clip) return null;
      if (time == null) return this._apply(entityId, animation, clip, { emitSample: options.emit !== false });
      return DataModel.sampleAnimationClip(clip, time, { unit: options.unit || 'seconds', loop: options.loop ?? (typeof animation.loop === 'boolean' ? animation.loop : clip.loop) });
    }
    _mod(value, divisor) {
      if (!(divisor > 0)) return 0;
      return ((value % divisor) + divisor) % divisor;
    }
    _effectiveSpeed(animation, clip) {
      if (Number.isFinite(Number(animation.speed))) return Number(animation.speed);
      if (Number.isFinite(Number(clip?.speed))) return Number(clip.speed);
      return 1;
    }
    _eventOccurrences(clip, start, end, loop) {
      if (start === end) return [];
      const duration = clip.frameCount / clip.fps;
      const direction = end > start ? 1 : -1;
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      const events = [];
      for (const track of clip.tracks.filter(item => item.type === 'event')) {
        for (const keyframe of track.keyframes) {
          const eventTime = keyframe.frame / clip.fps;
          if (!loop) {
            const crossed = direction > 0 ? eventTime > start && eventTime <= end : eventTime < start && eventTime >= end;
            if (crossed) events.push({ occurrence: eventTime, direction, track, keyframe });
            continue;
          }
          const firstCycle = Math.floor((low - eventTime) / duration) - 1;
          const lastCycle = Math.ceil((high - eventTime) / duration) + 1;
          for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
            const occurrence = eventTime + cycle * duration;
            const crossed = direction > 0 ? occurrence > start && occurrence <= end : occurrence < start && occurrence >= end;
            if (crossed) events.push({ occurrence, direction, track, keyframe });
          }
        }
      }
      events.sort((left, right) => direction > 0 ? left.occurrence - right.occurrence : right.occurrence - left.occurrence);
      return events;
    }
    _resolveTrackTarget(entityId, authoredTargetId) {
      const targetId = String(authoredTargetId == null ? '' : authoredTargetId).trim();
      if (!targetId) return this.engine.ecs.entities.has(entityId) ? entityId : null;
      const ownerMarker = this.engine.ecs.get(entityId, 'PrefabInstance');
      if (ownerMarker?.prefabId && ownerMarker?.instanceRootId) {
        for (const candidateId of this.engine.ecs.query('PrefabInstance')) {
          const marker = this.engine.ecs.get(candidateId, 'PrefabInstance');
          if (marker?.prefabId === ownerMarker.prefabId &&
              marker?.instanceRootId === ownerMarker.instanceRootId &&
              marker?.sourceEntityId === targetId) return candidateId;
        }
      }
      return this.engine.ecs.entities.has(targetId) ? targetId : null;
    }
    _collectHitboxes(entityId, sample) {
      const hitboxes = [];
      for (const track of sample?.tracks || []) {
        if (track.type !== 'hitbox') continue;
        const targetId = this._resolveTrackTarget(entityId, track.targetEntityId);
        if (!targetId) continue;
        hitboxes.push({ ...clone(track.value), trackId: track.trackId, keyframeId: track.keyframeId, targetEntityId: targetId });
      }
      return hitboxes;
    }
    _emitEvents(entityId, animation, clip, start, end, loop) {
      for (const item of this._eventOccurrences(clip, start, end, loop)) {
        const value = item.keyframe.value && typeof item.keyframe.value === 'object' ? item.keyframe.value : { name: String(item.keyframe.value || 'Event') };
        const occurrenceSample = DataModel.sampleAnimationClip(clip, item.keyframe.frame, { unit: 'frame', loop: false });
        const hitboxes = this._collectHitboxes(entityId, occurrenceSample);
        this.engine.events.emit('animation:event', {
          entityId,
          clipId: clip.id,
          trackId: item.track.id,
          keyframeId: item.keyframe.id,
          frame: item.keyframe.frame,
          time: item.keyframe.frame / clip.fps,
          name: value.name,
          payload: clone(value.payload),
          direction: item.direction,
          hitboxes: clone(hitboxes),
          animation,
          engine: this.engine
        });
      }
    }
    _apply(entityId, animation, clip, options = {}) {
      if (!clip) return null;
      const loop = typeof animation.loop === 'boolean' ? animation.loop : clip.loop;
      const sample = DataModel.sampleAnimationClip(clip, Math.max(0, finite(animation.time, 0)), { loop });
      for (const track of sample.tracks) {
        if (track.type === 'hitbox') continue;
        const targetId = this._resolveTrackTarget(entityId, track.targetEntityId);
        if (!targetId) continue;
        if (track.type === 'position') {
          const transform = this.engine.ecs.get(targetId, 'Transform');
          if (transform && track.value && typeof track.value === 'object') {
            if (Number.isFinite(Number(track.value.x))) transform.x = Number(track.value.x);
            if (Number.isFinite(Number(track.value.y))) transform.y = Number(track.value.y);
          }
        } else if (track.type === 'rotation') {
          const transform = this.engine.ecs.get(targetId, 'Transform');
          const rotation = track.value && typeof track.value === 'object' ? track.value.rotation : track.value;
          if (transform && Number.isFinite(Number(rotation))) transform.rotation = Number(rotation);
        } else if (track.type === 'sprite' && track.value && typeof track.value === 'object') {
          const renderable = this.engine.ecs.get(targetId, 'Renderable');
          if (renderable) Object.assign(renderable, clone(track.value));
        }
      }
      const hitboxes = this._collectHitboxes(entityId, sample);
      animation.clipId = clip.id;
      animation.duration = sample.duration;
      animation.frameCount = clip.frameCount;
      animation.frame = sample.frame;
      animation.sampledHitboxes = hitboxes;
      if (options.emitSample !== false) this.engine.events.emit('animation:sample', { entityId, clipId: clip.id, sample, hitboxes: clone(hitboxes), animation, engine: this.engine });
      return { ...sample, hitboxes };
    }
    _updateLegacy(entityId, animation, dt) {
      const duration = Math.max(0, finite(animation.duration, 0));
      if (!animation.playing || !duration) return;
      const speed = this._effectiveSpeed(animation, null);
      const next = Math.max(0, finite(animation.time, 0)) + dt * speed;
      if (animation.loop === false) {
        if ((speed >= 0 && next >= duration) || (speed < 0 && next <= 0)) {
          animation.time = speed < 0 ? 0 : duration;
          animation.playing = false;
          animation.completed = true;
          this.engine.events.emit('animation:complete', { entityId, clipId: null, animation, engine: this.engine });
        } else animation.time = clamp(next, 0, duration);
      } else animation.time = this._mod(next, duration);
    }
    update(dt) {
      dt = Math.max(0, finite(dt, 0));
      this.time += dt;
      this.engine.ecs.query('Animation').forEach(entityId => {
        const animation = this.engine.ecs.get(entityId, 'Animation');
        const clip = this._clipFor(animation);
        if (!clip) { this._updateLegacy(entityId, animation, dt); return; }
        if (animation.playing == null && animation.autoplay) animation.playing = true;
        const duration = clip.frameCount / clip.fps;
        const start = clamp(finite(animation.time, 0), 0, duration);
        const speed = this._effectiveSpeed(animation, clip);
        const rawEnd = start + (animation.playing ? dt * speed : 0);
        const loop = typeof animation.loop === 'boolean' ? animation.loop : clip.loop;
        let completed = false;
        if (loop) animation.time = this._mod(rawEnd, duration);
        else {
          animation.time = clamp(rawEnd, 0, duration);
          completed = Boolean(animation.playing && ((speed >= 0 && rawEnd >= duration) || (speed < 0 && rawEnd <= 0)));
        }
        const sample = this._apply(entityId, animation, clip, { emitSample: true });
        if (animation.playing && rawEnd !== start) this._emitEvents(entityId, animation, clip, start, loop ? rawEnd : animation.time, loop);
        if (completed) {
          animation.playing = false;
          animation.completed = true;
          this.engine.events.emit('animation:complete', { entityId, clipId: clip.id, time: animation.time, frame: animation.frame, animation, engine: this.engine });
        } else if (animation.playing) animation.completed = false;
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
  const resolveDefaultBox2D = explicit => {
    if (explicit !== undefined) return explicit;
    if (global.planck) return global.planck;
    if (global.Box2D) return global.Box2D;
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      try { return require('planck'); } catch (_) { /* The deterministic adapter remains available. */ }
    }
    return null;
  };
  const isPlanckAPI = api => Boolean(
    api && typeof api.World === 'function' && typeof api.Vec2 === 'function' &&
    typeof api.Box === 'function' && typeof api.Circle === 'function'
  );
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
      this.implementation = 'ah2d-builtin';
      this.status = 'ready';
      this.native = false;
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
      this.positionIterations = Math.max(1, Math.floor(finite(options.positionIterations, 3)));
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
    setPixelsPerMeter(value) {
      const next = Math.max(PHYSICS_EPSILON, finite(value, this.pixelsPerMeter || 100));
      if (Math.abs(next - this.pixelsPerMeter) <= PHYSICS_EPSILON) return this;
      this.pixelsPerMeter = next;
      this.bodies.forEach(body => { this._updateMass(body); this.wake(body); });
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
        pixelsPerMeter: this.pixelsPerMeter,
        bodies: [...this.bodies].map(([id, body]) => [id, {
          position: { ...body.position }, rotation: body.rotation, velocity: { ...body.velocity },
          angularVelocity: body.angularVelocity, sleeping: body.sleeping, sleepTime: body.sleepTime
        }])
      };
    }
    restore(snapshot) {
      if (!snapshot) return false;
      if (Number.isFinite(snapshot.pixelsPerMeter) && snapshot.pixelsPerMeter > 0) {
        this.setPixelsPerMeter(snapshot.pixelsPerMeter);
      }
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
    constructor(box2d, options = {}) {
      let selected = box2d;
      const looksLikeAPI = isPlainObject(box2d) && ['World', 'Vec2', 'Box', 'Circle'].some(key => key in box2d);
      if (arguments.length === 1 && isPlainObject(box2d) && !looksLikeAPI) {
        options = box2d;
        selected = undefined;
      }
      super(options);
      this.name = 'box2d';
      this.requestedImplementation = 'planck';
      this.api = resolveDefaultBox2D(selected);
      this.world = null;
      this.nativeBodies = new Map();
      this.nativeFixtures = new Map();
      this.nativeFixtureMetadata = new WeakMap();
      this.nativeListeners = [];
      this.nativeBegins = new Map();
      this.nativeEnds = new Map();
      this.usingNative = false;
      this.nativeError = null;
      this.initialize(options);
    }
    initialize(options = {}) {
      super.initialize(options);
      this.pixelsPerMeter = Math.max(PHYSICS_EPSILON, finite(options.pixelsPerMeter, this.pixelsPerMeter || 100));
      this.nativeBodies ||= new Map();
      this.nativeFixtures ||= new Map();
      this.nativeFixtureMetadata ||= new WeakMap();
      this.nativeListeners ||= [];
      this.nativeBegins ||= new Map();
      this.nativeEnds ||= new Map();
      if (!isPlanckAPI(this.api)) {
        this.world = null;
        this.usingNative = false;
        this.backend = 'builtin';
        this.implementation = 'ah2d-builtin';
        this.status = 'fallback';
        this.native = false;
        return this;
      }
      try {
        this._createNativeWorld();
      } catch (error) {
        this.nativeError = error;
        this.world = null;
        this.usingNative = false;
        this.backend = 'builtin';
        this.implementation = 'ah2d-builtin';
        this.status = 'fallback';
        this.native = false;
      }
      return this;
    }
    _createNativeWorld() {
      this._disposeNativeWorld();
      const gravity = this._nativeVector(this.gravity.x / this.pixelsPerMeter, this.gravity.y / this.pixelsPerMeter);
      let world;
      try { world = new this.api.World(gravity); } catch (_) { world = this.api.World(gravity); }
      if (!world || typeof world.step !== 'function' || typeof world.createBody !== 'function' ||
          typeof world.destroyBody !== 'function' || typeof world.on !== 'function') {
        throw new Error('Planck-shaped World API is unavailable');
      }
      this.world = world;
      this.usingNative = true;
      this.backend = 'box2d';
      this.implementation = 'planck';
      this.status = 'ready';
      this.native = true;
      this.nativeError = null;
      this.world.setAutoClearForces?.(false);
      this._bindNativeContacts();
      return world;
    }
    _bindNativeContacts() {
      this.nativeListeners = [];
      const bind = (name, listener) => {
        this.world.on(name, listener);
        this.nativeListeners.push([name, listener]);
      };
      bind('begin-contact', contact => {
        const value = this._nativeContactDescriptor(contact);
        if (value) this.nativeBegins.set(value.key, value);
      });
      bind('end-contact', contact => {
        const value = this._nativeContactDescriptor(contact);
        if (value) this.nativeEnds.set(value.key, value);
      });
    }
    _disposeNativeWorld() {
      if (this.world && typeof this.world.off === 'function') {
        for (const [name, listener] of this.nativeListeners || []) {
          try { this.world.off(name, listener); } catch (_) { /* The old World is being discarded. */ }
        }
      }
      this.nativeListeners = [];
      this.nativeBodies?.clear();
      this.nativeFixtures?.clear();
      this.nativeBegins?.clear();
      this.nativeEnds?.clear();
      this.nativeFixtureMetadata = new WeakMap();
      this.world = null;
    }
    setGravity(x, y) {
      super.setGravity(x, y);
      if (this.usingNative) {
        this.world.setGravity(this._nativeVector(
          this.gravity.x / this.pixelsPerMeter,
          this.gravity.y / this.pixelsPerMeter
        ));
      }
      return this;
    }
    getNativeWorld() { return this.usingNative ? this.world : null; }
    getNativeBody(entityId) { return this.usingNative ? this.nativeBodies.get(entityId) || null : null; }
    getNativeFixture(entityId, colliderId) {
      if (!this.usingNative) return null;
      return this.nativeFixtures.get(this._fixtureKey(entityId, colliderId)) || null;
    }
    setPixelsPerMeter(value) {
      const previous = this.pixelsPerMeter;
      const next = Math.max(PHYSICS_EPSILON, finite(value, previous || 100));
      if (Math.abs(next - previous) <= PHYSICS_EPSILON) return this;
      this.bodies.forEach(body => this._restoreNativeQueuedForces(body));
      this.pixelsPerMeter = next;
      this.bodies.forEach(body => this._updateMass(body));
      if (!isPlanckAPI(this.api)) return this;
      try {
        this._createNativeWorld();
        this.contacts.clear();
        this.bodies.forEach(body => this._writeNativeBody(body, true));
      } catch (error) {
        this._fallback(error);
      }
      return this;
    }
    restore(snapshot) {
      const restored = super.restore(snapshot);
      if (!restored || !this.usingNative) return restored;
      try {
        this.bodies.forEach(body => this._writeNativeBody(body, false));
      } catch (error) {
        this._fallback(error);
      }
      return restored;
    }
    wake(entityId) {
      const result = super.wake(entityId);
      const id = typeof entityId === 'object' ? entityId.entityId : entityId;
      if (result) this.nativeBodies?.get(id)?.setAwake?.(true);
      return result;
    }
    sleep(entityId) {
      const result = super.sleep(entityId);
      const id = typeof entityId === 'object' ? entityId.entityId : entityId;
      const nativeBody = this.nativeBodies?.get(id);
      if (result && nativeBody) {
        nativeBody.setLinearVelocity?.(this._nativeVector(0, 0));
        nativeBody.setAngularVelocity?.(0);
        nativeBody.setAwake?.(false);
      }
      return result;
    }
    setTransform(entityId, x, y, rotation) {
      const result = super.setTransform(entityId, x, y, rotation);
      const body = this.bodies.get(entityId), nativeBody = this.nativeBodies?.get(entityId);
      if (result && body && nativeBody) nativeBody.setTransform(
        this._nativeVector(body.position.x / this.pixelsPerMeter, body.position.y / this.pixelsPerMeter),
        body.rotation * DEG_TO_RAD
      );
      return result;
    }
    setVelocity(entityId, x, y) {
      const result = super.setVelocity(entityId, x, y);
      const body = this.bodies.get(entityId), nativeBody = this.nativeBodies?.get(entityId);
      if (result && body && nativeBody) nativeBody.setLinearVelocity(this._nativeVector(
        body.velocity.x / this.pixelsPerMeter,
        body.velocity.y / this.pixelsPerMeter
      ));
      return result;
    }
    setAngularVelocity(entityId, degreesPerSecond) {
      const result = super.setAngularVelocity(entityId, degreesPerSecond);
      const body = this.bodies.get(entityId), nativeBody = this.nativeBodies?.get(entityId);
      if (result && body && nativeBody) nativeBody.setAngularVelocity(body.angularVelocity * DEG_TO_RAD);
      return result;
    }
    applyImpulse(entityId, x, y, point = null) {
      const body = this.bodies.get(entityId), nativeBody = this.nativeBodies?.get(entityId);
      if (!this.usingNative || !body || !nativeBody || body.type !== BODY_TYPES.DYNAMIC || typeof nativeBody.applyLinearImpulse !== 'function') {
        return super.applyImpulse(entityId, x, y, point);
      }
      const impulse = typeof x === 'object' ? vector(x) : { x: finite(x, 0), y: finite(y, 0) };
      const worldPoint = point
        ? this._nativeVector(finite(point.x, body.position.x) / this.pixelsPerMeter, finite(point.y, body.position.y) / this.pixelsPerMeter)
        : nativeBody.getWorldCenter();
      nativeBody.applyLinearImpulse(
        this._nativeVector(impulse.x / this.pixelsPerMeter, impulse.y / this.pixelsPerMeter),
        worldPoint,
        true
      );
      this._readNativeBody(body);
      return true;
    }
    destroyBody(entityId, options = {}) {
      const nativeBody = this.nativeBodies.get(entityId);
      if (nativeBody && this.world) {
        try { this.world.destroyBody(nativeBody); } catch (_) { /* Already removed. */ }
      }
      this._forgetNativeFixtures(entityId);
      this.nativeBodies.delete(entityId);
      this._purgeNativePending(entityId);
      const body = this.bodies.get(entityId);
      if (body) this._discardNativeQueuedForces(body);
      return super.destroyBody(entityId, options);
    }
    clear(options = {}) {
      let eventError = null;
      try { super.clear(options); } catch (error) { eventError = error; }
      this.nativeBodies.clear();
      this.nativeFixtures.clear();
      this.nativeBegins.clear();
      this.nativeEnds.clear();
      this.nativeFixtureMetadata = new WeakMap();
      if (eventError) throw eventError;
      return this;
    }
    sync(engine, phase = 'both') {
      if (!this.usingNative) return super.sync(engine, phase);
      this.engine = engine;
      let inheritedBodyChanged = false;
      if (phase !== 'after') {
        super.sync(engine, 'before');
        try { this.bodies.forEach(body => this._writeNativeBody(body, true)); } catch (error) { this._fallback(error); }
      }
      if (phase !== 'before') {
        if (this.usingNative) {
          try { this.bodies.forEach(body => this._readNativeBody(body)); } catch (error) { this._fallback(error); }
        }
        inheritedBodyChanged = super.sync(engine, 'after');
        if (inheritedBodyChanged && this.usingNative) {
          try { this.bodies.forEach(body => this._writeNativeBody(body, false)); } catch (error) { this._fallback(error); }
        }
      }
      return inheritedBodyChanged;
    }
    step(dt, engine = this.engine) {
      if (!this.usingNative) return super.step(dt, engine);
      dt = clamp(finite(dt, 0), 0, 0.25);
      if (dt <= 0) return;
      let contacts;
      try {
        const requested = Math.max(1, Math.ceil(dt / this.maxStep));
        const maximum = Math.max(1, Math.floor(finite(this.options.maxSubSteps, 32)));
        const count = Math.min(requested, maximum);
        const stepTime = dt / count;
        for (let index = 0; index < count; index += 1) {
          this.world.step(stepTime, this.velocityIterations, this.positionIterations);
        }
        this.world.clearForces?.();
        this.bodies.forEach(body => {
          this._discardNativeQueuedForces(body);
          this._readNativeBody(body);
        });
        contacts = this._collectNativeContacts();
      } catch (error) {
        try { this.world?.clearForces?.(); } catch (_) { /* Preserve the physics error. */ }
        this.bodies.forEach(body => this._restoreNativeQueuedForces(body));
        this._fallback(error);
        return super.step(dt, engine);
      }
      this._emitNativeContactChanges(contacts, engine);
    }
    _nativeVector(x, y) {
      try { return this.api.Vec2(x, y); } catch (_) { return new this.api.Vec2(x, y); }
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
    _fixtureKey(entityId, colliderId) { return `${entityId}\u0000${colliderId}`; }
    _forgetNativeFixtures(entityId) {
      for (const [key, fixture] of [...this.nativeFixtures]) {
        const metadata = this.nativeFixtureMetadata.get(fixture);
        if (metadata?.entityId === entityId) this.nativeFixtures.delete(key);
      }
    }
    _purgeNativePending(entityId) {
      const purge = values => {
        for (const [key, value] of values) {
          if (value.bodyA?.entityId === entityId || value.bodyB?.entityId === entityId) values.delete(key);
        }
      };
      purge(this.nativeBegins);
      purge(this.nativeEnds);
    }
    _writeNativeBody(body, applyQueuedForces = true) {
      let nativeBody = this.nativeBodies.get(body.entityId);
      const fixtures = body.colliders
        .filter(collider => collider.enabled)
        .map(collider => ({ collider, geometry: this._nativeFixtureGeometry(body, collider) }));
      const signatureNumber = value => Math.round(value * 1e9) / 1e9;
      const signature = JSON.stringify({
        type: body.type,
        mass: signatureNumber(body.mass),
        useAutoMass: body.useAutoMass,
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
        this._restoreNativeQueuedForces(body);
        try { this.world.destroyBody(nativeBody); } catch (_) { /* Recreated below. */ }
        this._forgetNativeFixtures(body.entityId);
        this.nativeBodies.delete(body.entityId);
        nativeBody = null;
      }
      if (!nativeBody) {
        const definition = {
          type: body.type,
          position: this._nativeVector(body.position.x / this.pixelsPerMeter, body.position.y / this.pixelsPerMeter),
          angle: body.rotation * DEG_TO_RAD,
          linearDamping: body.linearDamping,
          angularDamping: body.angularDamping,
          gravityScale: body.gravityScale,
          fixedRotation: body.fixedRotation,
          allowSleep: body.allowSleep,
          awake: !body.sleeping,
          bullet: body.bullet,
          active: body.enabled,
          userData: body.entityId
        };
        nativeBody = this.world.createBody(definition);
        nativeBody.__ah2dColliderSignature = signature;
        nativeBody.setUserData?.(body.entityId);
        this.nativeBodies.set(body.entityId, nativeBody);
        const weightedArea = fixtures.reduce((sum, fixture) => {
          if (fixture.collider.isTrigger) return sum;
          const geometry = fixture.geometry;
          const area = (geometry.shape === COLLIDER_SHAPES.CIRCLE
            ? Math.PI * geometry.radius * geometry.radius
            : geometry.halfX * geometry.halfY * 4) / (this.pixelsPerMeter * this.pixelsPerMeter);
          return sum + area * fixture.collider.density;
        }, 0);
        const densityScale = body.type === BODY_TYPES.DYNAMIC && !body.useAutoMass
          ? body.mass / Math.max(PHYSICS_EPSILON, weightedArea)
          : 1;
        fixtures.forEach(({ collider, geometry }) => {
          const offset = this._nativeVector(geometry.offsetX / this.pixelsPerMeter, geometry.offsetY / this.pixelsPerMeter);
          const shape = geometry.shape === COLLIDER_SHAPES.CIRCLE
            ? this.api.Circle(offset, geometry.radius / this.pixelsPerMeter)
            : this.api.Box(
                geometry.halfX / this.pixelsPerMeter,
                geometry.halfY / this.pixelsPerMeter,
                offset,
                geometry.rotation
              );
          const fixture = nativeBody.createFixture(shape, {
            density: body.type === BODY_TYPES.DYNAMIC && !collider.isTrigger ? collider.density * densityScale : 0,
            friction: collider.friction,
            restitution: collider.restitution,
            isSensor: collider.isTrigger,
            filterCategoryBits: collider.categoryBits,
            filterMaskBits: collider.maskBits,
            filterGroupIndex: collider.groupIndex
          });
          const metadata = { entityId: body.entityId, colliderId: collider.id };
          fixture.setUserData?.(metadata);
          this.nativeFixtureMetadata.set(fixture, metadata);
          this.nativeFixtures.set(this._fixtureKey(body.entityId, collider.id), fixture);
        });
        nativeBody.resetMassData?.();
        if (body.type === BODY_TYPES.DYNAMIC && weightedArea <= PHYSICS_EPSILON && typeof nativeBody.setMassData === 'function') {
          nativeBody.setMassData({
            mass: body.mass,
            center: this._nativeVector(0, 0),
            I: body.fixedRotation ? 0 : Math.max(
              PHYSICS_EPSILON,
              body.inertia / (this.pixelsPerMeter * this.pixelsPerMeter)
            )
          });
        }
      }
      const position = this._nativeVector(body.position.x / this.pixelsPerMeter, body.position.y / this.pixelsPerMeter);
      nativeBody.setTransform(position, body.rotation * DEG_TO_RAD);
      const velocity = this._nativeVector(body.velocity.x / this.pixelsPerMeter, body.velocity.y / this.pixelsPerMeter);
      nativeBody.setLinearVelocity(velocity);
      nativeBody.setAngularVelocity(body.angularVelocity * DEG_TO_RAD);
      nativeBody.setGravityScale?.(body.gravityScale);
      nativeBody.setFixedRotation?.(body.fixedRotation);
      nativeBody.setActive?.(body.enabled);
      nativeBody.setEnabled?.(body.enabled);
      nativeBody.setAwake?.(!body.sleeping);
      if (applyQueuedForces) this._applyNativeQueuedForces(body, nativeBody);
    }
    _applyNativeQueuedForces(body, nativeBody) {
      if (body.force.x || body.force.y) {
        body._nativeAppliedForce ||= { x: 0, y: 0 };
        body._nativeAppliedForce.x += body.force.x;
        body._nativeAppliedForce.y += body.force.y;
        nativeBody.applyForceToCenter(
          this._nativeVector(body.force.x / this.pixelsPerMeter, body.force.y / this.pixelsPerMeter),
          true
        );
        body.force.x = 0;
        body.force.y = 0;
      }
      if (body.torque) {
        body._nativeAppliedTorque = finite(body._nativeAppliedTorque, 0) + body.torque;
        nativeBody.applyTorque?.(body.torque / (this.pixelsPerMeter * this.pixelsPerMeter), true);
        body.torque = 0;
      }
    }
    _restoreNativeQueuedForces(body) {
      if (body._nativeAppliedForce) {
        body.force.x += body._nativeAppliedForce.x;
        body.force.y += body._nativeAppliedForce.y;
      }
      if (body._nativeAppliedTorque) body.torque += body._nativeAppliedTorque;
      this._discardNativeQueuedForces(body);
    }
    _discardNativeQueuedForces(body) {
      delete body._nativeAppliedForce;
      delete body._nativeAppliedTorque;
    }
    _readNativeBody(body) {
      const nativeBody = this.nativeBodies.get(body.entityId);
      if (!nativeBody) return;
      const position = nativeBody.getPosition();
      const velocity = nativeBody.getLinearVelocity();
      if (position) {
        body.position.x = finite(position.x, 0) * this.pixelsPerMeter;
        body.position.y = finite(position.y, 0) * this.pixelsPerMeter;
      }
      if (velocity) {
        body.velocity.x = finite(velocity.x, 0) * this.pixelsPerMeter;
        body.velocity.y = finite(velocity.y, 0) * this.pixelsPerMeter;
      }
      body.rotation = finite(nativeBody.getAngle(), 0) * RAD_TO_DEG;
      body.angularVelocity = finite(nativeBody.getAngularVelocity(), 0) * RAD_TO_DEG;
      const nativeMass = nativeBody.getMass?.();
      const nativeInertia = nativeBody.getInertia?.();
      if (body.type === BODY_TYPES.DYNAMIC && Number.isFinite(nativeMass) && nativeMass > 0) body.mass = nativeMass;
      if (Number.isFinite(nativeInertia)) body.inertia = nativeInertia * this.pixelsPerMeter * this.pixelsPerMeter;
      body.inverseMass = body.type === BODY_TYPES.DYNAMIC ? 1 / Math.max(PHYSICS_EPSILON, body.mass) : 0;
      body.inverseInertia = body.type === BODY_TYPES.DYNAMIC && !body.fixedRotation
        ? 1 / Math.max(PHYSICS_EPSILON, body.inertia || body.mass)
        : 0;
      body.sleeping = !nativeBody.isAwake();
    }
    _fixtureMetadata(fixture) {
      const value = this.nativeFixtureMetadata.get(fixture) || fixture?.getUserData?.();
      return value && typeof value.entityId === 'string' && typeof value.colliderId === 'string' ? value : null;
    }
    _nativeContactDescriptor(contact) {
      if (!contact) return null;
      let fixtureA = contact.getFixtureA?.(), fixtureB = contact.getFixtureB?.();
      let metadataA = this._fixtureMetadata(fixtureA), metadataB = this._fixtureMetadata(fixtureB);
      if (!metadataA || !metadataB) return null;
      let bodyA = this.bodies.get(metadataA.entityId), bodyB = this.bodies.get(metadataB.entityId);
      if (!bodyA || !bodyB) return null;
      let colliderA = bodyA.colliders.find(value => value.id === metadataA.colliderId);
      let colliderB = bodyB.colliders.find(value => value.id === metadataB.colliderId);
      if (!colliderA || !colliderB) return null;
      let normal = { x: 1, y: 0 };
      let point = {
        x: (bodyA.position.x + bodyB.position.x) * 0.5,
        y: (bodyA.position.y + bodyB.position.y) * 0.5
      };
      let penetration = 0;
      try {
        const manifold = contact.getWorldManifold?.(null);
        if (manifold?.normal) normal = vector(manifold.normal, 1, 0);
        const nativePoint = manifold?.points?.find(value => value && Number.isFinite(value.x) && Number.isFinite(value.y));
        if (nativePoint) point = { x: nativePoint.x * this.pixelsPerMeter, y: nativePoint.y * this.pixelsPerMeter };
        const separations = (manifold?.separations || []).filter(Number.isFinite);
        if (separations.length) penetration = Math.max(0, -Math.min(...separations) * this.pixelsPerMeter);
      } catch (_) { /* End-contact may no longer expose a populated manifold. */ }
      let keyA = this._fixtureKey(metadataA.entityId, metadataA.colliderId);
      let keyB = this._fixtureKey(metadataB.entityId, metadataB.colliderId);
      if (keyA > keyB) {
        [keyA, keyB] = [keyB, keyA];
        [bodyA, bodyB] = [bodyB, bodyA];
        [colliderA, colliderB] = [colliderB, colliderA];
        [fixtureA, fixtureB] = [fixtureB, fixtureA];
        normal = { x: -normal.x, y: -normal.y };
      }
      return {
        key: `${keyA}|${keyB}`,
        bodyA,
        bodyB,
        colliderA,
        colliderB,
        fixtureA,
        fixtureB,
        normal: normalize(normal),
        penetration,
        point,
        trigger: Boolean(colliderA.isTrigger || colliderB.isTrigger || fixtureA?.isSensor?.() || fixtureB?.isSensor?.())
      };
    }
    _collectNativeContacts() {
      const contacts = new Map();
      let contact = this.world.getContactList?.() || null;
      while (contact) {
        if ((contact.isEnabled?.() ?? true) && (contact.isTouching?.() ?? true)) {
          const value = this._nativeContactDescriptor(contact);
          if (value) contacts.set(value.key, value);
        }
        contact = contact.getNext?.() || null;
      }
      return contacts;
    }
    _emitNativeContactChanges(next, engine = this.engine) {
      const previous = this.contacts;
      const operations = [];
      next.forEach((contact, key) => {
        const before = previous.get(key);
        if (before && before.trigger === contact.trigger) {
          if (this.nativeEnds.has(key) && this.nativeBegins.has(key)) operations.push([before, 'end'], [contact, 'start']);
          else operations.push([contact, 'stay']);
        } else {
          if (before) operations.push([before, 'end']);
          operations.push([this.nativeBegins.get(key) || contact, 'start']);
        }
      });
      previous.forEach((contact, key) => {
        if (!next.has(key)) operations.push([this.nativeEnds.get(key) || contact, 'end']);
      });
      this.nativeBegins.forEach((contact, key) => {
        if (!previous.has(key) && !next.has(key)) {
          operations.push([contact, 'start']);
          const ended = this.nativeEnds.get(key);
          if (ended) operations.push([ended, 'end']);
        }
      });
      this.contacts = next;
      this.nativeBegins.clear();
      this.nativeEnds.clear();
      let eventError = null;
      for (const [contact, phase] of operations) {
        try { this._emitContactEvent(engine?.events, contact, phase); }
        catch (error) { if (!eventError) eventError = error; }
      }
      if (eventError) throw eventError;
    }
    _fallback(error) {
      this.nativeError = error;
      try { this.bodies.forEach(body => this._readNativeBody(body)); } catch (_) { /* Retain the last readable state. */ }
      this._disposeNativeWorld();
      this.bodies.forEach(body => this._restoreNativeQueuedForces(body));
      this.usingNative = false;
      this.native = false;
      this.backend = 'builtin';
      this.implementation = 'ah2d-builtin';
      this.status = 'fallback';
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
      record = { node, visualHost, childrenHost, visual: null, visualKind: null, sourceKey: null, textureGeneration: 0, ownedTexture: null };
      this.nodes.set(id, record);
      return record;
    }
    _removeNode(id) {
      const record = this.nodes.get(id);
      if (!record) return;
      record.textureGeneration += 1;
      this._releaseOwnedTexture(record);
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
      const sourceRect = this._sourceRect(renderable);
      const frameKey = sourceRect ? `${sourceRect.x},${sourceRect.y},${sourceRect.width},${sourceRect.height}` : '';
      return {
        key: `${renderable.assetId || ''}|${source == null ? '' : String(source)}|${frameKey}`,
        source,
        sourceRect,
        hasTexture: source != null && source !== ''
      };
    }
    _sourceRect(renderable) {
      const rect = renderable?.sourceRect;
      if (!rect || typeof rect !== 'object' || Array.isArray(rect)) return null;
      const x = Number(rect.x), y = Number(rect.y), width = Number(rect.width), height = Number(rect.height);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
      return { x, y, width, height };
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
    _releaseOwnedTexture(record) {
      if (!record?.ownedTexture) return;
      record.ownedTexture.destroy?.(false);
      record.ownedTexture = null;
    }
    _framedTexture(texture, sourceRect) {
      if (!texture || !sourceRect) return { texture, owned: false };
      const source = texture.source || texture.baseTexture;
      if (!source || typeof this.PIXI.Texture !== 'function') return { texture, owned: false };
      const frame = this.PIXI.Rectangle
        ? new this.PIXI.Rectangle(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height)
        : { ...sourceRect };
      try { return { texture: new this.PIXI.Texture({ source, frame }), owned: true }; }
      catch (_) {
        try { return { texture: new this.PIXI.Texture(source, frame), owned: true }; }
        catch (_) { return { texture, owned: false }; }
      }
    }
    _assignTexture(record, texture, sourceRect) {
      const baseTexture = texture || this._whiteTexture();
      const framed = this._framedTexture(baseTexture, sourceRect);
      this._releaseOwnedTexture(record);
      record.ownedTexture = framed.owned ? framed.texture : null;
      record.visual.texture = framed.texture || baseTexture;
    }
    _destroyVisual(record) {
      if (!record.visual) return;
      this._releaseOwnedTexture(record);
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
      const { key, source, sourceRect, hasTexture } = this._textureSource(renderable);
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
        this._assignTexture(record, this._whiteTexture(), null);
        Promise.resolve(resolved).then(texture => {
          if (this.nodes.get(id) !== record || record.textureGeneration !== textureGeneration || record.sourceKey !== key) return;
          const resolvedTexture = typeof texture === 'string' && this.PIXI.Texture?.from ? this.PIXI.Texture.from(texture) : (texture || this._whiteTexture());
          this._assignTexture(record, resolvedTexture, sourceRect);
          this._renderApplication();
        }).catch(error => {
          if (this.nodes.get(id) === record && record.textureGeneration === textureGeneration) {
            this.engine.events.emit('runtime:textureError', { runtime: this, entityId: id, source, error, engine: this.engine });
          }
        });
      } else this._assignTexture(record, resolved || this._whiteTexture(), sourceRect);
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
      const sourceRect = this._sourceRect(renderable);
      const width = finite(renderable.width, sourceRect?.width ?? 64);
      const height = finite(renderable.height, sourceRect?.height ?? 64);
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
      // Pixi v8's canvas/view accessors dereference renderer. During a failed
      // async init the renderer does not exist yet, so cleanup must not mask
      // the original initialization error with an accessor exception.
      let canvas = null;
      try { canvas = app.canvas || null; } catch (_) { /* Application.init did not finish. */ }
      if (!canvas) {
        try { canvas = app.view || null; } catch (_) { /* Legacy accessor can fail for the same reason. */ }
      }
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

  const prefabError = (code, message, details, pointer = '') => new DataModel.ComponentSchemaError(code, message, { pointer, details });

  class PrefabSystem {
    constructor(engine) { this.engine = engine; }
    _document() {
      const document = this.engine.document;
      if (!isPlainObject(document) || Number(document.version) !== 4 || !Array.isArray(document.scenes)) {
        throw prefabError('E_PREFAB_AUTHORING_DOCUMENT', 'Prefab authoring requires a loaded Universal Project version 4 with Scenes');
      }
      return document;
    }
    _activeScene(document = this._document()) {
      const id = this.engine.activeSceneId || document.currentSceneId || document.meta?.currentSceneId;
      const scene = document.scenes.find(item => item?.id === id) || document.scenes[0];
      if (!scene || !Array.isArray(scene.objects)) throw prefabError('E_PREFAB_SCENE', 'The active Scene must contain an objects array', { sceneId: id });
      return scene;
    }
    _asset(document, prefabId, required = true) {
      const asset = (Array.isArray(document.prefabs) ? document.prefabs : []).find(item => item?.id === prefabId) || null;
      if (!asset && required) throw prefabError('E_PREFAB_ASSET_MISSING', `Prefab Asset does not exist: ${prefabId}`, { prefabId });
      return asset;
    }
    _marker(entity) {
      if (!isPlainObject(entity)) return null;
      const resolved = this.engine.entityCodec.resolve(entity, 'PrefabInstance');
      if (!resolved.found || !isPlainObject(resolved.value)) return null;
      const value = resolved.value;
      if (!['sourceEntityId', 'instanceRootId'].some(key => value[key] != null)) return null;
      if (!['prefabId', 'sourceEntityId', 'instanceRootId'].every(key => typeof value[key] === 'string' && value[key].trim())) {
        throw prefabError('E_PREFAB_INSTANCE_ID', 'PrefabInstance requires non-empty prefabId, sourceEntityId, and instanceRootId', { entityId: entity.id });
      }
      return { resolved, value };
    }
    _setMarker(entity, value) {
      this.engine.entityCodec.write(entity, 'PrefabInstance', value, { storage: 'preserve', profile: DataModel.PROFILES.AUTHORING });
      return entity;
    }
    _removeMarker(entity) {
      return this.engine.entityCodec.remove(entity, 'PrefabInstance', { allLocations: true });
    }
    _scopes(document) {
      return (Array.isArray(document.scenes) ? document.scenes : [])
        .filter(scene => isPlainObject(scene) && Array.isArray(scene.objects))
        .map(scene => ({ scene, objects: scene.objects }));
    }
    _findActiveEntity(document, entityId) {
      const scene = this._activeScene(document);
      const entity = scene.objects.find(item => item?.id === entityId);
      if (!entity) throw prefabError('E_PREFAB_INSTANCE_ENTITY', `Entity does not exist in the active Scene: ${entityId}`, { entityId, sceneId: scene.id });
      return { scene, entity };
    }
    _instanceMembers(objects, marker) {
      return objects.map(entity => ({ entity, marker: this._marker(entity) })).filter(item => item.marker &&
        item.marker.value.prefabId === marker.prefabId && item.marker.value.instanceRootId === marker.instanceRootId);
    }
    _source(asset, sourceEntityId) {
      const source = asset.entities.find(entity => entity?.id === sourceEntityId);
      if (!source) throw prefabError('E_PREFAB_INSTANCE_SOURCE_MISSING', `Prefab source Entity does not exist: ${sourceEntityId}`, { prefabId: asset.id, sourceEntityId });
      return source;
    }
    _syncMirror(document) {
      const scene = this._activeScene(document);
      document.currentSceneId = scene.id;
      if (isPlainObject(document.meta)) document.meta.currentSceneId = scene.id;
      document.scene = clone(scene.objects);
    }
    _commit(document, event, payload) {
      this._syncMirror(document);
      DataModel.assertPrefabDocument(document, { entityCodec: this.engine.entityCodec });
      const sceneId = this._activeScene(document).id;
      this.engine.load(document, { sceneId });
      const detail = clone(payload);
      this.engine.events.emit(event, { ...detail, engine: this.engine });
      return detail;
    }
    _uniqueEntityId(objects, prefix) {
      const occupied = new Set(objects.map(entity => entity?.id));
      let candidate;
      do { candidate = `${prefix}_${uid()}`; } while (occupied.has(candidate));
      return candidate;
    }
    _assertOverridePath(path) {
      DataModel.parseJsonPointer(path);
      if (!DataModel.prefabOverridePathAllowed(path)) {
        throw prefabError('E_PREFAB_OVERRIDE_PROTECTED', 'Prefab override cannot change Entity identity, hierarchy, or its PrefabInstance marker', { path }, path);
      }
      return path;
    }
    _assertMemberOverridePath(entity, marker, path) {
      this._assertOverridePath(path);
      if (entity.id === marker.instanceRootId && DataModel.prefabRootPlacementPath(path)) {
        throw prefabError('E_PREFAB_PLACEMENT_PATH', 'Transform fields on an instance root are placement and cannot be stored as Prefab overrides', {
          entityId: entity.id, path
        }, path);
      }
      return path;
    }
    _overrideRecordForState(source, target, path, prior = {}) {
      const sourceState = DataModel.jsonPointerLookup(source, path);
      const targetState = DataModel.jsonPointerLookup(target, path);
      if (!sourceState.found && !targetState.found) return null;
      if (sourceState.found && targetState.found && JSON.stringify(sourceState.value) === JSON.stringify(targetState.value)) return null;
      if (!targetState.found) {
        const record = { ...(isPlainObject(prior) ? clone(prior) : {}), op: 'remove' };
        delete record.value;
        return record;
      }
      return {
        ...(isPlainObject(prior) ? clone(prior) : {}),
        op: sourceState.found ? 'replace' : 'add',
        value: clone(targetState.value)
      };
    }
    _rebaseApplyOperation(source, target, path, prior = {}) {
      const candidates = [];
      const segments = DataModel.parseJsonPointer(path);
      for (let length = segments.length; length > 0; length -= 1) {
        const candidatePath = this._pointerFromSegments(segments.slice(0, length));
        if (!DataModel.prefabOverridePathAllowed(candidatePath)) continue;
        const operation = this._overrideRecordForState(source, target, candidatePath, prior);
        if (!operation) {
          if (length === segments.length) return null;
          continue;
        }
        candidates.push({ path: candidatePath, operation });
      }
      let firstError = null;
      for (const candidate of candidates) {
        try {
          const projected = clone(source);
          DataModel.applyPrefabOverrideOperation(projected, candidate.path, candidate.operation);
          return candidate;
        } catch (error) {
          if (!firstError) firstError = error;
          if (error?.code !== 'E_PREFAB_OVERRIDE_TARGET') throw error;
        }
      }
      if (firstError) throw firstError;
      return null;
    }
    _pointerFromSegments(segments) {
      return '/' + segments.map(segment => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
    }
    _projectPrefabOverrides(source, overrides) {
      const projected = clone(source);
      for (const [overridePath, record] of Object.entries(isPlainObject(overrides) ? overrides : {})) {
        if (!isPlainObject(record) || !DataModel.PREFAB_OVERRIDE_OPERATIONS.includes(record.op)) continue;
        DataModel.applyPrefabOverrideOperation(projected, overridePath, record);
      }
      return projected;
    }
    _replaceProjectedBranch(target, projected, path) {
      const expected = DataModel.jsonPointerLookup(projected, path);
      const current = DataModel.jsonPointerLookup(target, path);
      if (!expected.found) {
        if (current.found) DataModel.applyJsonPointerOperation(target, path, { op: 'remove' });
        return target;
      }
      DataModel.applyJsonPointerOperation(target, path, {
        op: current.found ? 'replace' : 'add',
        value: expected.value
      });
      return target;
    }
    _arrayParentContext(source, target, path) {
      const segments = DataModel.parseJsonPointer(path);
      const rawIndex = segments.at(-1);
      if (!/^(0|[1-9]\d*)$/.test(rawIndex || '')) return null;
      const parentSegments = segments.slice(0, -1);
      if (!parentSegments.length) return null;
      const parentPath = this._pointerFromSegments(parentSegments);
      const sourceParent = DataModel.jsonPointerLookup(source, parentPath);
      const targetParent = DataModel.jsonPointerLookup(target, parentPath);
      if (!sourceParent.found || !targetParent.found || !Array.isArray(sourceParent.value) || !Array.isArray(targetParent.value)) return null;
      return { segments, rawIndex, index: Number(rawIndex), parentSegments, parentPath, sourceParent, targetParent };
    }
    _arrayBranchPath(source, target, path) {
      const segments = DataModel.parseJsonPointer(path);
      for (let position = segments.length - 1; position >= 0; position -= 1) {
        if (!/^(0|[1-9]\d*)$/.test(segments[position]) || position === 0) continue;
        const parentPath = this._pointerFromSegments(segments.slice(0, position));
        const sourceParent = DataModel.jsonPointerLookup(source, parentPath);
        const targetParent = DataModel.jsonPointerLookup(target, parentPath);
        if ((sourceParent.found && Array.isArray(sourceParent.value)) || (targetParent.found && Array.isArray(targetParent.value))) return parentPath;
      }
      return null;
    }
    _promoteArrayOverride(source, target, parentPath, overrides, prior = {}) {
      const next = {};
      for (const [existing, record] of Object.entries(isPlainObject(overrides) ? overrides : {})) {
        if (existing === parentPath || existing.startsWith(`${parentPath}/`)) continue;
        Object.defineProperty(next, existing, { value: clone(record), enumerable: true, writable: true, configurable: true });
      }
      const promoted = this._overrideRecordForState(source, target, parentPath, prior);
      if (promoted) Object.defineProperty(next, parentPath, { value: promoted, enumerable: true, writable: true, configurable: true });
      return next;
    }
    _normalizeArrayOverrideState(source, target, marker, editedPath) {
      const overrides = isPlainObject(marker.overrides) ? clone(marker.overrides) : {};
      const parentPath = this._arrayBranchPath(source, target, editedPath);
      if (!parentPath) return { ...marker, overrides };
      try {
        const projected = this._projectPrefabOverrides(source, overrides);
        const expected = DataModel.jsonPointerLookup(projected, parentPath);
        const actual = DataModel.jsonPointerLookup(target, parentPath);
        if (expected.found === actual.found && (!expected.found || JSON.stringify(expected.value) === JSON.stringify(actual.value))) {
          return { ...marker, overrides };
        }
      } catch (_) {}
      return {
        ...marker,
        overrides: this._promoteArrayOverride(source, target, parentPath, overrides, overrides[editedPath] || {})
      };
    }
    _syncArrayMutation(source, target, path, overrides, operation, options = {}) {
      if (!['add', 'replace', 'remove'].includes(operation.op)) return null;
      const context = this._arrayParentContext(source, target, path);
      if (!context) {
        const parentPath = this._arrayBranchPath(source, target, path);
        if (!parentPath) return null;
        const next = isPlainObject(overrides) ? clone(overrides) : {};
        const projected = this._projectPrefabOverrides(source, next);
        this._replaceProjectedBranch(target, projected, parentPath);
        return next;
      }
      const { parentSegments, parentPath, index } = context;
      const next = isPlainObject(overrides) ? clone(overrides) : {};
      const entries = Object.entries(next).map(([existing, record], order) => {
        let parts;
        try { parts = DataModel.parseJsonPointer(existing); } catch (_) { return null; }
        if (parts.length <= parentSegments.length ||
            parentSegments.some((segment, position) => parts[position] !== segment) ||
            !/^(0|[1-9]\d*)$/.test(parts[parentSegments.length])) return null;
        return { path: existing, parts, index: Number(parts[parentSegments.length]), record, order };
      }).filter(Boolean);
      const ancestorOwner = Object.keys(next)
        .filter(existing => existing !== path && path.startsWith(`${existing}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (ancestorOwner) {
        const rebased = this._overrideRecordForState(source, target, ancestorOwner, next[ancestorOwner]);
        if (rebased) next[ancestorOwner] = rebased; else delete next[ancestorOwner];
        return next;
      }

      let limitedPaths = options.reindexPaths instanceof Set ? options.reindexPaths : null;
      if (operation.op === 'remove' && entries.some(entry => entry.index === index)) {
        const exactEntries = entries.filter(entry => entry.index === index);
        const redundantRemove = exactEntries.find(entry =>
          entry.index === index && entry.parts.length === parentSegments.length + 1 && entry.record?.op === 'remove'
        );
        const localInsertion = exactEntries.length === 1 &&
          exactEntries[0].parts.length === parentSegments.length + 1 && exactEntries[0].record?.op === 'add';
        if (redundantRemove) {
          // The local removal and Asset removal now express the same change.
          // Records authored before that local removal still use the old Asset
          // coordinates; later records already use the shortened array.
          delete next[redundantRemove.path];
          limitedPaths = new Set(entries.filter(entry => entry.order < redundantRemove.order).map(entry => entry.path));
        } else if (!localInsertion) {
        // Removing the Asset element would orphan an exact/descendant override.
        // Promote ownership to the complete array so the effective instance
        // remains reconstructable against the shorter Asset array.
          const prior = entries.find(entry => entry.index === index)?.record || {};
          return this._promoteArrayOverride(source, target, parentPath, next, prior);
        }
      }

      const remapped = new Map(entries.map(entry => [entry.path, entry.path]));
      for (const entry of entries) {
        if (limitedPaths && !limitedPaths.has(entry.path)) continue;
        if (operation.op === 'replace') continue;
        if (operation.op === 'remove' && entry.index <= index) continue;
        if (operation.op === 'add' && entry.index < index) continue;
        const shiftedParts = entry.parts.slice();
        shiftedParts[parentSegments.length] = String(entry.index + (operation.op === 'add' ? 1 : -1));
        remapped.set(entry.path, this._pointerFromSegments(shiftedParts));
      }
      const staged = {};
      for (const [existing, record] of Object.entries(next)) {
        const shiftedPath = remapped.get(existing) || existing;
        if (Object.prototype.hasOwnProperty.call(staged, shiftedPath)) {
          return this._promoteArrayOverride(source, target, parentPath, next, record);
        }
        Object.defineProperty(staged, shiftedPath, { value: clone(record), enumerable: true, writable: true, configurable: true });
      }
      try {
        const projected = this._projectPrefabOverrides(source, staged);
        this._replaceProjectedBranch(target, projected, parentPath);
      } catch (_) {
        return this._promoteArrayOverride(source, target, parentPath, staged, entries[0]?.record || {});
      }
      return staged;
    }
    _rebaseArrayAfterRevert(source, target, path, overrides, operation, followingPaths) {
      if (!['add', 'remove'].includes(operation.op)) return null;
      const context = this._arrayParentContext(source, target, path);
      if (!context) return null;
      const { parentSegments, parentPath, index } = context;
      const following = followingPaths instanceof Set ? followingPaths : new Set(followingPaths || []);
      const remapped = new Map();
      for (const existing of Object.keys(overrides)) {
        if (!following.has(existing)) continue;
        let parts;
        try { parts = DataModel.parseJsonPointer(existing); } catch (_) { continue; }
        if (parts.length <= parentSegments.length ||
            parentSegments.some((segment, position) => parts[position] !== segment) ||
            !/^(0|[1-9]\d*)$/.test(parts[parentSegments.length])) continue;
        const existingIndex = Number(parts[parentSegments.length]);
        const shouldShift = operation.op === 'add' ? existingIndex > index : existingIndex >= index;
        if (!shouldShift) continue;
        parts[parentSegments.length] = String(existingIndex + (operation.op === 'add' ? -1 : 1));
        remapped.set(existing, this._pointerFromSegments(parts));
      }
      const staged = {};
      for (const [existing, record] of Object.entries(overrides)) {
        const shiftedPath = remapped.get(existing) || existing;
        if (Object.prototype.hasOwnProperty.call(staged, shiftedPath)) {
          return this._promoteArrayOverride(source, target, parentPath, overrides, record);
        }
        Object.defineProperty(staged, shiftedPath, { value: clone(record), enumerable: true, writable: true, configurable: true });
      }
      try {
        const projected = this._projectPrefabOverrides(source, staged);
        this._replaceProjectedBranch(target, projected, parentPath);
        return staged;
      } catch (_) {
        return this._promoteArrayOverride(source, target, parentPath, staged, Object.values(staged)[0] || {});
      }
    }
    _syncPathPreservingOverrides(source, target, path, overrides, operation, options = {}) {
      const nextOverrides = isPlainObject(overrides) ? clone(overrides) : {};
      const paths = Object.keys(nextOverrides);
      const arrayResult = this._syncArrayMutation(source, target, path, nextOverrides, operation, options);
      if (arrayResult) return arrayResult;
      if (options.operationAlreadyApplied === true) return nextOverrides;
      // An exact override or an override of an ancestor owns the effective
      // value, so this Asset change must not touch that branch.
      const owner = paths
        .filter(existing => existing === path || path.startsWith(`${existing}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (owner) {
        const rebased = this._overrideRecordForState(source, target, owner, nextOverrides[owner]);
        if (rebased) nextOverrides[owner] = rebased; else delete nextOverrides[owner];
        return nextOverrides;
      }
      const branchBefore = DataModel.jsonPointerLookup(target, path);
      const descendants = paths.filter(existing => existing.startsWith(`${path}/`)).map(existing => ({
        path: existing,
        effective: (() => {
          const current = DataModel.jsonPointerLookup(target, existing);
          return { found: current.found, value: current.found ? clone(current.value) : undefined };
        })()
      }));
      DataModel.applyJsonPointerOperation(target, path, operation);
      for (const descendant of descendants) {
        const after = DataModel.jsonPointerLookup(target, descendant.path);
        try {
          if (descendant.effective.found) {
            DataModel.applyJsonPointerOperation(target, descendant.path, {
              op: after.found ? 'replace' : 'add', value: descendant.effective.value
            });
          } else if (after.found) DataModel.applyJsonPointerOperation(target, descendant.path, { op: 'remove' });
        } catch (error) {
          // The Asset removed/retyped a parent required by this descendant
          // override. Preserve the previous effective branch and promote the
          // record to the changed ancestor so validation and future sync stay
          // deterministic.
          const currentBranch = DataModel.jsonPointerLookup(target, path);
          if (!branchBefore.found) throw error;
          DataModel.applyJsonPointerOperation(target, path, {
            op: currentBranch.found ? 'replace' : 'add', value: branchBefore.value
          });
          const prior = nextOverrides[descendant.path];
          for (const existing of Object.keys(nextOverrides)) {
            if (existing === path || existing.startsWith(`${path}/`)) delete nextOverrides[existing];
          }
          const promoted = this._overrideRecordForState(source, target, path, prior);
          if (promoted) nextOverrides[path] = promoted;
          return nextOverrides;
        }
        const sourceValue = DataModel.jsonPointerLookup(source, descendant.path);
        if (!descendant.effective.found && !sourceValue.found) delete nextOverrides[descendant.path];
        else nextOverrides[descendant.path] = descendant.effective.found
          ? { ...nextOverrides[descendant.path], op: sourceValue.found ? 'replace' : 'add', value: clone(descendant.effective.value) }
          : { ...nextOverrides[descendant.path], op: 'remove' };
      }
      return nextOverrides;
    }
    _recordOverride(marker, path, operation, entity = null) {
      const overrides = isPlainObject(marker.overrides) ? clone(marker.overrides) : {};
      const priorAtPath = isPlainObject(overrides[path]) ? clone(overrides[path]) : null;
      const owner = Object.keys(overrides)
        .filter(existing => existing !== path && path.startsWith(`${existing}/`))
        .sort((a, b) => b.length - a.length)[0];
      if (owner && entity) {
        const ownerOperation = overrides[owner];
        const effective = DataModel.jsonPointerLookup(entity, owner);
        // A descendant edit inside an existing add/replace is still one
        // override of the owning branch. Rebase its value from the effective
        // Entity instead of replacing it with a narrower record, otherwise
        // sibling differences owned by the ancestor would be lost on sync.
        if (effective.found && isPlainObject(ownerOperation) && ownerOperation.op !== 'remove') {
          for (const existing of Object.keys(overrides)) {
            if (existing !== owner && (existing.startsWith(`${owner}/`) || owner.startsWith(`${existing}/`))) delete overrides[existing];
          }
          overrides[owner] = { ...ownerOperation, value: clone(effective.value) };
          return { ...marker, overrides };
        }
      }
      for (const existing of Object.keys(overrides)) {
        if (existing !== path && (existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))) delete overrides[existing];
      }
      if (!operation) delete overrides[path];
      if (operation) {
        const record = { ...(priorAtPath || {}), ...clone(operation) };
        if (record.op === 'remove') delete record.value;
        Object.defineProperty(overrides, path, { value: record, enumerable: true, writable: true, configurable: true });
      }
      return { ...marker, overrides };
    }
    _revertOperation(source, target, path, operation) {
      const sourceValue = DataModel.jsonPointerLookup(source, path);
      const targetValue = DataModel.jsonPointerLookup(target, path);
      if (operation.op === 'add' && !sourceValue.found) {
        if (targetValue.found) DataModel.applyJsonPointerOperation(target, path, { op: 'remove' });
        return;
      }
      if (!sourceValue.found) {
        if (targetValue.found) DataModel.applyJsonPointerOperation(target, path, { op: 'remove' });
        return;
      }
      DataModel.applyJsonPointerOperation(target, path, {
        // A remove shifts an array; add restores the element even when the
        // same numeric index now resolves to its former sibling. A stale add
        // rebases to the current source instead of deleting a newly-owned path.
        op: operation.op === 'remove' ? 'add' : (targetValue.found ? 'replace' : 'add'),
        value: sourceValue.value
      });
    }
    list() { return clone(Array.isArray(this.engine.document?.prefabs) ? this.engine.document.prefabs : []); }
    get(prefabId) {
      const asset = this._asset(this._document(), prefabId, false);
      return asset ? clone(asset) : null;
    }
    getInstance(entityId) {
      const document = this._document();
      const { scene, entity } = this._findActiveEntity(document, entityId);
      const marker = this._marker(entity);
      if (!marker) return null;
      const asset = this._asset(document, marker.value.prefabId);
      const members = this._instanceMembers(scene.objects, marker.value);
      return clone({
        prefabId: marker.value.prefabId,
        instanceRootId: marker.value.instanceRootId,
        prefabRevision: marker.value.prefabRevision ?? null,
        asset,
        members: members.map(item => ({
          entityId: item.entity.id,
          sourceEntityId: item.marker.value.sourceEntityId,
          overrides: item.marker.value.overrides || {}
        }))
      });
    }
    createAsset(rootEntityId, options = {}) {
      const document = clone(this._document());
      const scene = this._activeScene(document);
      const root = scene.objects.find(entity => entity?.id === rootEntityId);
      if (!root) throw prefabError('E_PREFAB_SOURCE_ROOT', `Entity does not exist in the active Scene: ${rootEntityId}`, { rootEntityId });
      if (this._marker(root)) throw prefabError('E_PREFAB_ALREADY_INSTANCE', `Entity is already part of a Prefab instance: ${rootEntityId}`, { rootEntityId });
      const prefabId = String(options.id || `prefab_${rootEntityId}`).trim();
      if (!prefabId) throw prefabError('E_PREFAB_ID', 'Prefab Asset id must be a non-empty string');
      if (this._asset(document, prefabId, false)) throw prefabError('E_PREFAB_ID_DUPLICATE', `Prefab Asset already exists: ${prefabId}`, { prefabId });
      const selected = new Set([rootEntityId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const entity of scene.objects) {
          if (!selected.has(entity.id) && selected.has(entity.parentId)) { selected.add(entity.id); changed = true; }
        }
      }
      const connectedDescendant = scene.objects.find(entity => selected.has(entity.id) && this._marker(entity));
      if (connectedDescendant) {
        throw prefabError(
          'E_PREFAB_NESTED_INSTANCE',
          `Connected Prefab member must be unpacked before creating an Asset from this subtree: ${connectedDescendant.id}`,
          { rootEntityId, entityId: connectedDescendant.id }
        );
      }
      const entities = scene.objects.filter(entity => selected.has(entity.id)).map(entity => clone(entity));
      const sourceRoot = entities.find(entity => entity.id === rootEntityId);
      sourceRoot.parentId = null;
      const sourceTransform = this.engine.entityCodec.resolve(sourceRoot, 'Transform');
      this.engine.entityCodec.write(sourceRoot, 'Transform', {
        ...sourceTransform.value,
        x: 0,
        y: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1
      }, { storage: 'preserve', profile: DataModel.PROFILES.AUTHORING });
      const revision = options.revision == null ? 1 : options.revision;
      const extensions = isPlainObject(options.extensions) ? clone(options.extensions) : {};
      const asset = {
        ...extensions,
        id: prefabId,
        name: options.name == null ? String(root.name || rootEntityId) : String(options.name),
        rootEntityId,
        revision,
        entities
      };
      if (!Array.isArray(document.prefabs)) document.prefabs = [];
      document.prefabs.push(asset);
      const linkedEntityIds = [];
      if (options.linkSource !== false) {
        for (const entity of scene.objects) {
          if (!selected.has(entity.id)) continue;
          const existingMarker = this.engine.entityCodec.resolve(entity, 'PrefabInstance');
          this._setMarker(entity, {
            ...(existingMarker.found && isPlainObject(existingMarker.value) ? clone(existingMarker.value) : {}),
            prefabId,
            sourceEntityId: entity.id,
            instanceRootId: rootEntityId,
            prefabRevision: revision,
            overrides: {}
          });
          linkedEntityIds.push(entity.id);
        }
      }
      this._commit(document, 'prefab:assetCreate', { prefabId, rootEntityId, linkedEntityIds });
      return this.get(prefabId);
    }
    deleteAsset(prefabId, options = {}) {
      const document = clone(this._document());
      const asset = this._asset(document, prefabId);
      const linked = [];
      for (const { scene, objects } of this._scopes(document)) {
        for (const entity of objects) {
          const marker = this._marker(entity);
          if (marker?.value.prefabId === prefabId) linked.push({ sceneId: scene.id, entity, marker: marker.value });
        }
      }
      if (linked.length && options.unpackInstances !== true) {
        throw prefabError('E_PREFAB_ASSET_IN_USE', `Cannot delete Prefab Asset ${prefabId} while linked instances exist`, {
          prefabId, instanceRootIds: [...new Set(linked.map(item => item.marker.instanceRootId))]
        });
      }
      if (options.unpackInstances === true) linked.forEach(item => this._removeMarker(item.entity));
      document.prefabs.splice(document.prefabs.indexOf(asset), 1);
      const instanceRootIds = [...new Set(linked.map(item => item.marker.instanceRootId))];
      this._commit(document, 'prefab:assetDelete', { prefabId, instanceRootIds, unpacked: options.unpackInstances === true });
      return true;
    }
    instantiate(prefabId, options = {}) {
      const document = clone(this._document());
      const asset = this._asset(document, prefabId);
      const scene = this._activeScene(document);
      const existingIds = new Set(scene.objects.map(entity => entity?.id));
      const parentId = options.parentId == null ? null : options.parentId;
      if (parentId != null && !existingIds.has(parentId)) throw prefabError('E_DANGLING_PARENT', `Parent does not exist in the active Scene: ${parentId}`, { parentId });
      if (parentId != null) {
        const parent = scene.objects.find(entity => entity?.id === parentId);
        const parentMarker = this._marker(parent);
        if (parentMarker) {
          throw prefabError(
            'E_PREFAB_STRUCTURAL_EDIT',
            `Cannot instantiate a Prefab below a connected Prefab member: ${parentId}`,
            { prefabId, parentId, instanceRootId: parentMarker.value.instanceRootId }
          );
        }
      }
      const requestedMap = options.idMap instanceof Map ? options.idMap : new Map(Object.entries(isPlainObject(options.idMap) ? options.idMap : {}));
      if (options.rootId != null) requestedMap.set(asset.rootEntityId, options.rootId);
      const idMap = new Map();
      for (const source of asset.entities) {
        let id = requestedMap.get(source.id);
        if (id == null && typeof options.idFactory === 'function') id = options.idFactory(source, asset, scene);
        if (id == null) id = this._uniqueEntityId([...scene.objects, ...[...idMap.values()].map(value => ({ id: value }))], `${prefabId}_${source.id}`);
        id = String(id).trim();
        if (!id) throw prefabError('E_ENTITY_ID', `Generated instance Entity id is empty for source ${source.id}`, { prefabId, sourceEntityId: source.id });
        if (existingIds.has(id) || [...idMap.values()].includes(id)) throw prefabError('E_ENTITY_EXISTS', `Entity already exists: ${id}`, { prefabId, sourceEntityId: source.id, entityId: id });
        idMap.set(source.id, id);
      }
      const instanceRootId = idMap.get(asset.rootEntityId);
      const instances = asset.entities.map(source => {
        const entity = clone(source);
        entity.id = idMap.get(source.id);
        entity.parentId = source.id === asset.rootEntityId ? parentId : idMap.get(source.parentId);
        const existingMarker = this.engine.entityCodec.resolve(entity, 'PrefabInstance');
        this._removeMarker(entity);
        this._setMarker(entity, {
          ...(existingMarker.found && isPlainObject(existingMarker.value) ? clone(existingMarker.value) : {}),
          prefabId,
          sourceEntityId: source.id,
          instanceRootId,
          prefabRevision: Number.isInteger(asset.revision) ? asset.revision : 0,
          overrides: {}
        });
        return entity;
      });
      const instanceRoot = instances.find(entity => entity.id === instanceRootId);
      if (isPlainObject(options.transform)) {
        const resolved = this.engine.entityCodec.resolve(instanceRoot, 'Transform');
        this.engine.entityCodec.write(instanceRoot, 'Transform', { ...resolved.value, ...clone(options.transform) }, {
          storage: 'preserve', profile: DataModel.PROFILES.AUTHORING
        });
      }
      scene.objects.push(...instances);
      const result = {
        prefabId,
        instanceRootId,
        entityIds: instances.map(entity => entity.id),
        idMap: Object.fromEntries(idMap)
      };
      this._commit(document, 'prefab:instantiate', result);
      return clone(result);
    }
    setOverride(entityId, path, value, options = {}) {
      const document = clone(this._document());
      const { entity } = this._findActiveEntity(document, entityId);
      const marker = this._marker(entity);
      if (!marker) throw prefabError('E_PREFAB_NOT_INSTANCE', `Entity is not part of a Prefab instance: ${entityId}`, { entityId });
      this._assertMemberOverridePath(entity, marker.value, path);
      const asset = this._asset(document, marker.value.prefabId);
      const source = this._source(asset, marker.value.sourceEntityId);
      const current = DataModel.jsonPointerLookup(entity, path);
      const sourceCurrent = DataModel.jsonPointerLookup(source, path);
      const op = sourceCurrent.found ? 'replace' : 'add';
      if (options.op != null && options.op !== op) throw prefabError('E_PREFAB_OVERRIDE_OPERATION', `Override must use ${op} because the path ${sourceCurrent.found ? 'exists in' : 'is absent from'} the Prefab Asset`, { requested: options.op, expected: op, path });
      const operation = { op, value: clone(value) };
      DataModel.applyJsonPointerOperation(entity, path, { op: current.found ? 'replace' : 'add', value });
      const recorded = this._recordOverride(marker.value, path, operation, entity);
      this._setMarker(entity, this._normalizeArrayOverrideState(source, entity, recorded, path));
      const result = { entityId, prefabId: marker.value.prefabId, instanceRootId: marker.value.instanceRootId, path, operation };
      this._commit(document, 'prefab:override', result);
      return clone(result);
    }
    removeOverride(entityId, path) {
      const document = clone(this._document());
      const { entity } = this._findActiveEntity(document, entityId);
      const marker = this._marker(entity);
      if (!marker) throw prefabError('E_PREFAB_NOT_INSTANCE', `Entity is not part of a Prefab instance: ${entityId}`, { entityId });
      this._assertMemberOverridePath(entity, marker.value, path);
      const asset = this._asset(document, marker.value.prefabId);
      const source = this._source(asset, marker.value.sourceEntityId);
      const sourceCurrent = DataModel.jsonPointerLookup(source, path);
      const current = DataModel.jsonPointerLookup(entity, path);
      if (!current.found) throw prefabError('E_PREFAB_OVERRIDE_TARGET', `Prefab override target does not exist: ${path}`, { entityId, path });
      if (!sourceCurrent.found) {
        DataModel.applyJsonPointerOperation(entity, path, { op: 'remove' });
        const recorded = this._recordOverride(marker.value, path, null, entity);
        this._setMarker(entity, this._normalizeArrayOverrideState(source, entity, recorded, path));
        const result = { entityId, prefabId: marker.value.prefabId, instanceRootId: marker.value.instanceRootId, path, operation: null, reverted: true };
        this._commit(document, 'prefab:override', result);
        return clone(result);
      }
      const operation = { op: 'remove' };
      DataModel.applyJsonPointerOperation(entity, path, operation);
      const recorded = this._recordOverride(marker.value, path, operation, entity);
      this._setMarker(entity, this._normalizeArrayOverrideState(source, entity, recorded, path));
      const result = { entityId, prefabId: marker.value.prefabId, instanceRootId: marker.value.instanceRootId, path, operation };
      this._commit(document, 'prefab:override', result);
      return clone(result);
    }
    revert(entityId, path = null, options = {}) {
      if (isPlainObject(path)) { options = path; path = null; }
      if (path != null) this._assertOverridePath(path);
      const document = clone(this._document());
      const { scene, entity } = this._findActiveEntity(document, entityId);
      const marker = this._marker(entity);
      if (!marker) throw prefabError('E_PREFAB_NOT_INSTANCE', `Entity is not part of a Prefab instance: ${entityId}`, { entityId });
      if (path != null) this._assertMemberOverridePath(entity, marker.value, path);
      const asset = this._asset(document, marker.value.prefabId);
      const targets = options.instance === true ? this._instanceMembers(scene.objects, marker.value) : [{ entity, marker }];
      const reverted = [];
      for (const target of targets) {
        let overrides = isPlainObject(target.marker.value.overrides) ? clone(target.marker.value.overrides) : {};
        const paths = path == null ? Object.keys(overrides) : [path];
        const source = this._source(asset, target.marker.value.sourceEntityId);
        for (const targetPath of paths) {
          if (!Object.prototype.hasOwnProperty.call(overrides, targetPath)) {
            if (path != null) throw prefabError('E_PREFAB_OVERRIDE_MISSING', `Prefab override does not exist: ${targetPath}`, { entityId: target.entity.id, path: targetPath });
            continue;
          }
          if (!isPlainObject(overrides[targetPath]) || !DataModel.PREFAB_OVERRIDE_OPERATIONS.includes(overrides[targetPath].op)) {
            throw prefabError('E_PREFAB_OVERRIDE_OPERATION', `Legacy Prefab override cannot be reverted automatically: ${targetPath}`, { entityId: target.entity.id, path: targetPath });
          }
          const operation = overrides[targetPath];
          const orderedPaths = Object.keys(overrides);
          const targetIndex = orderedPaths.indexOf(targetPath);
          const followingPaths = targetIndex < 0 ? [] : orderedPaths.slice(targetIndex + 1);
          this._revertOperation(source, target.entity, targetPath, operation);
          delete overrides[targetPath];
          if (path != null) {
            overrides = this._rebaseArrayAfterRevert(source, target.entity, targetPath, overrides, operation, new Set(followingPaths)) || overrides;
          }
          reverted.push({ entityId: target.entity.id, sourceEntityId: target.marker.value.sourceEntityId, path: targetPath });
        }
        this._setMarker(target.entity, { ...target.marker.value, overrides });
      }
      const result = { prefabId: marker.value.prefabId, instanceRootId: marker.value.instanceRootId, reverted };
      this._commit(document, 'prefab:revert', result);
      return clone(result);
    }
    apply(entityId, options = {}) {
      const document = clone(this._document());
      const { scene, entity } = this._findActiveEntity(document, entityId);
      const marker = this._marker(entity);
      if (!marker) throw prefabError('E_PREFAB_NOT_INSTANCE', `Entity is not part of a Prefab instance: ${entityId}`, { entityId });
      const asset = this._asset(document, marker.value.prefabId);
      const previousRevision = Number.isInteger(asset.revision) ? asset.revision : 0;
      const requestedPaths = options.paths == null ? null : (Array.isArray(options.paths) ? options.paths : [options.paths]);
      requestedPaths?.forEach(path => this._assertMemberOverridePath(entity, marker.value, path));
      const targets = requestedPaths || options.instance === false
        ? [{ entity, marker }]
        : this._instanceMembers(scene.objects, marker.value);
      const changes = [];
      const syncChanges = [];
      const cleared = [];
      for (const target of targets) {
        const overrides = isPlainObject(target.marker.value.overrides) ? clone(target.marker.value.overrides) : {};
        const paths = requestedPaths || Object.keys(overrides);
        const source = this._source(asset, target.marker.value.sourceEntityId);
        for (const path of paths) {
          const orderedOverridePaths = Object.keys(overrides);
          const pathIndex = orderedOverridePaths.indexOf(path);
          const priorOverridePaths = pathIndex < 0 ? [] : orderedOverridePaths.slice(0, pathIndex);
          let operation = overrides[path];
          if (!isPlainObject(operation) || !DataModel.PREFAB_OVERRIDE_OPERATIONS.includes(operation.op)) {
            throw prefabError('E_PREFAB_OVERRIDE_MISSING', `Canonical Prefab override does not exist: ${path}`, { entityId: target.entity.id, path });
          }
          let applyPath = path;
          if (target.marker.value.prefabRevision !== previousRevision) {
            const rebased = this._rebaseApplyOperation(source, target.entity, path, operation);
            if (!rebased) {
              delete overrides[path];
              cleared.push({ sourceEntityId: source.id, entityId: target.entity.id, path });
              continue;
            }
            applyPath = rebased.path;
            operation = rebased.operation;
          }
          try {
            DataModel.applyPrefabOverrideOperation(source, applyPath, operation);
          } catch (error) {
            if (error?.code !== 'E_PREFAB_OVERRIDE_TARGET') throw error;
            const rebased = this._rebaseApplyOperation(source, target.entity, path, operation);
            if (!rebased) {
              delete overrides[path];
              cleared.push({ sourceEntityId: source.id, entityId: target.entity.id, path });
              continue;
            }
            applyPath = rebased.path;
            operation = rebased.operation;
            DataModel.applyPrefabOverrideOperation(source, applyPath, operation);
          }
          delete overrides[path];
          if (applyPath !== path) {
            for (const existing of Object.keys(overrides)) {
              if (existing === applyPath || existing.startsWith(`${applyPath}/`) || applyPath.startsWith(`${existing}/`)) {
                delete overrides[existing];
                cleared.push({ sourceEntityId: source.id, entityId: target.entity.id, path: existing, promotedBy: path });
              }
            }
          }
          const change = {
            sourceEntityId: source.id,
            entityId: target.entity.id,
            sceneId: scene.id,
            instanceRootId: target.marker.value.instanceRootId,
            path: applyPath,
            operation: clone(operation)
          };
          changes.push(change);
          syncChanges.push({ ...change, originalPath: path, priorOverridePaths, sourceAfter: clone(source) });
        }
        this._setMarker(target.entity, { ...target.marker.value, overrides });
      }
      if (!changes.length && !cleared.length) throw prefabError('E_PREFAB_NO_OVERRIDES', 'No Prefab overrides are available to apply', { entityId });
      if (!changes.length) {
        const result = { prefabId: asset.id, instanceRootId: marker.value.instanceRootId, revision: previousRevision, changes, cleared };
        this._commit(document, 'prefab:apply', result);
        return clone(result);
      }
      const currentGroups = new Map();
      for (const { scene: candidateScene, objects } of this._scopes(document)) {
        for (const candidate of objects) {
          const candidateMarker = this._marker(candidate);
          if (!candidateMarker || candidateMarker.value.prefabId !== asset.id) continue;
          const key = `${candidateScene.id}\u0000${asset.id}\u0000${candidateMarker.value.instanceRootId}`;
          currentGroups.set(key, (currentGroups.get(key) ?? true) && candidateMarker.value.prefabRevision === previousRevision);
        }
      }
      asset.revision = previousRevision + 1;
      for (const { scene: targetScene, objects } of this._scopes(document)) {
        for (const target of objects) {
          const targetMarker = this._marker(target);
          if (!targetMarker || targetMarker.value.prefabId !== asset.id) continue;
          const groupKey = `${targetScene.id}\u0000${asset.id}\u0000${targetMarker.value.instanceRootId}`;
          const groupWasCurrent = currentGroups.get(groupKey) === true;
          let overrides = isPlainObject(targetMarker.value.overrides) ? clone(targetMarker.value.overrides) : {};
          if (groupWasCurrent) {
            for (const change of syncChanges) {
              if (targetMarker.value.sourceEntityId !== change.sourceEntityId) continue;
              const initiatingTarget = targetScene.id === change.sceneId && target.id === change.entityId &&
                targetMarker.value.instanceRootId === change.instanceRootId;
              overrides = this._syncPathPreservingOverrides(change.sourceAfter, target, change.path, overrides, change.operation, {
                operationAlreadyApplied: initiatingTarget,
                reindexPaths: initiatingTarget ? new Set(change.priorOverridePaths) : null
              });
            }
          }
          this._setMarker(target, {
            ...targetMarker.value,
            overrides,
            prefabRevision: groupWasCurrent ? asset.revision : targetMarker.value.prefabRevision
          });
        }
      }
      const result = { prefabId: asset.id, instanceRootId: marker.value.instanceRootId, revision: asset.revision, changes, cleared };
      this._commit(document, 'prefab:apply', result);
      return clone(result);
    }
    unpack(entityId) {
      const document = clone(this._document());
      const { scene, entity } = this._findActiveEntity(document, entityId);
      const marker = this._marker(entity);
      if (!marker) throw prefabError('E_PREFAB_NOT_INSTANCE', `Entity is not part of a Prefab instance: ${entityId}`, { entityId });
      const members = this._instanceMembers(scene.objects, marker.value);
      members.forEach(item => this._removeMarker(item.entity));
      const result = {
        prefabId: marker.value.prefabId,
        instanceRootId: marker.value.instanceRootId,
        entityIds: members.map(item => item.entity.id)
      };
      this._commit(document, 'prefab:unpack', result);
      return clone(result);
    }
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
      this.prefabs = new PrefabSystem(this);
      const physicsOptions = { ...(options.physicsOptions || {}) };
      if (options.gravity && !physicsOptions.gravity) physicsOptions.gravity = options.gravity;
      this._physicsOptions = { ...physicsOptions };
      this._box2d = options.box2d;
      this._physicsSelectionLocked = options.physics instanceof PhysicsAdapter || typeof options.physics === 'string';
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
    _selectDocumentPhysics(requested) {
      if (this._physicsSelectionLocked || !requested) return this.physics;
      const target = requested === 'builtin' || requested === 'ah2d-builtin' ? 'builtin' : 'box2d';
      if (this.physics?.name === target) return this.physics;
      const previous = this.physics;
      const options = {
        ...this._physicsOptions,
        ...(previous?.options || {}),
        gravity: previous?.gravity ? { ...previous.gravity } : this._physicsOptions.gravity,
        pixelsPerMeter: previous?.pixelsPerMeter ?? this._physicsOptions.pixelsPerMeter
      };
      this.physics = target === 'builtin'
        ? new PhysicsAdapter(options)
        : new Box2DPhysicsAdapter(this._box2d, options);
      this.physics.engine = this;
      return this.physics;
    }
    _configurePhysicsFromDocument(document) {
      const config = isPlainObject(document?.engine) ? document.engine : {};
      const requested = String(config.physics || 'box2d').trim().toLowerCase();
      if (requested && !['box2d', 'planck', 'builtin', 'ah2d-builtin'].includes(requested)) return;
      this._selectDocumentPhysics(requested);
      const pixelsPerMeter = Number(config.pixelsPerMeter);
      if (Number.isFinite(pixelsPerMeter) && pixelsPerMeter > 0) this.physics.setPixelsPerMeter?.(pixelsPerMeter);
      if (isPlainObject(config.gravity) && Number.isFinite(Number(config.gravity.x)) && Number.isFinite(Number(config.gravity.y))) {
        this.physics.setGravity?.({ x: Number(config.gravity.x), y: Number(config.gravity.y) });
      }
    }
    load(document, options = {}) {
      if (typeof options === 'string') options = { sceneId: options };
      if (!isPlainObject(document)) {
        throw new DataModel.ComponentSchemaError('E_DOCUMENT_TYPE', 'Project document must be a plain object');
      }
      const source = document;
      assertDataModelCompatibility(source);
      // ECS snapshots are intentionally definition-free and already contain
      // concrete expanded Entities. Universal authoring projects, however,
      // must keep every linked instance resolvable against its Prefab Asset.
      if (Number(source.version) === 4 || source.prefabs != null) {
        DataModel.assertPrefabDocument(source, { entityCodec: this.entityCodec });
      }
      DataModel.assertAnimationDocument(source, { entityCodec: this.entityCodec });
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
      if (!options.preservePhysicsAdapter) this._configurePhysicsFromDocument(source);
      this.ecs.clear(); this.graph.clear({ [GRAPH_INTERNAL]: true });
      stagedEcs.entities.forEach(id => this.ecs.entities.add(id));
      stagedEcs.components.forEach((store, type) => this.ecs.components.set(type, store));
      stagedGraph.nodes.forEach(id => this.graph.nodes.add(id));
      stagedGraph.parent.forEach((parent, child) => this.graph.parent.set(child, parent));
      stagedGraph.children.forEach((children, id) => this.graph.children.set(id, children));
      this.document = nextDocument;
      this.activeSceneId = activeScene?.id || null;
      this.animation.load(nextDocument);
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
        physicsAdapter: this.physics.name,
        animationTime: this.animation.time,
        activeCamera: this.camera.active,
        activeSceneId: this.activeSceneId
      };
    }
    restoreSnapshot(snapshot = this.playSnapshot) {
      if (!snapshot) return false;
      const runtime = snapshot.runtime || snapshot.document || snapshot;
      const authoringDocument = snapshot.runtime && snapshot.document ? clone(snapshot.document) : null;
      const snapshotAdapter = snapshot.physicsAdapter || authoringDocument?.engine?.physics;
      if (snapshotAdapter) this._selectDocumentPhysics(String(snapshotAdapter).toLowerCase());
      this.load(clone(runtime), { preservePhysicsAdapter: true });
      if (authoringDocument) {
        this.document = authoringDocument;
        this.activeSceneId = snapshot.activeSceneId || authoringDocument.currentSceneId || null;
        this.animation.load(authoringDocument);
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
      const animations = Array.isArray(editorState?.animations) ? editorState.animations : undefined;
      const engine = isPlainObject(editorState?.engine) ? editorState.engine : undefined;
      const signature = JSON.stringify({ scene, postProcess, animations, engine });
      if (signature === this.lastSignature) return false;
      this.lastSignature = signature;
      this.engine.load({ scene, postProcess, ...(animations ? { animations } : {}), ...(engine ? { engine } : {}) });
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
    normalizeAnimationClip: DataModel.normalizeAnimationClip,
    normalizeAnimationClips: DataModel.normalizeAnimationClips,
    sampleAnimationClip: DataModel.sampleAnimationClip,
    LightingSystem, ShadowSystem, AnimationSystem, PostProcessSystem, TilemapSystem,
    DEFAULT_POST_PROCESS_EFFECTS, createDefaultPostProcess, PrefabSystem,
    BODY_TYPES, COLLIDER_SHAPES, PhysicsAdapter, Box2DPhysicsAdapter,
    RuntimeAdapter, PixiRuntimeAdapter, PhaserRuntimeAdapter, CustomRuntimeAdapter,
    EditorBridge
  });
})(window);
