(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AH2DDataModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DATA_MODEL_ID = 'ah2d.ecs';
  const DATA_MODEL_VERSION = 1;
  const COMPONENT_SCHEMA_VERSION = 1;
  const PROFILES = Object.freeze({
    AUTHORING: 'authoring',
    RUNTIME: 'runtime',
    SNAPSHOT: 'snapshot'
  });
  const ANIMATION_TRACK_TYPES = Object.freeze(['sprite', 'position', 'rotation', 'event', 'hitbox', 'bone', 'ik']);
  const PROFILE_NAMES = Object.freeze(Object.values(PROFILES));
  const COMPONENT_NAME_PATTERN = '^[A-Z][A-Za-z0-9]*$';
  const COMPONENT_NAME_RE = new RegExp(COMPONENT_NAME_PATTERN);
  const FORBIDDEN_COMPONENT_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
  const NORMALIZATION_SOURCE = Symbol('AH2DDataModel.normalizationSource');
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  class ComponentSchemaError extends Error {
    constructor(code, message, options = {}) {
      super(message || code || 'Component schema error');
      this.name = 'ComponentSchemaError';
      this.code = code || 'E_COMPONENT_SCHEMA';
      this.pointer = options.pointer || '';
      this.diagnostics = Array.isArray(options.diagnostics) ? options.diagnostics : [];
      this.details = options.details;
      if (Error.captureStackTrace) Error.captureStackTrace(this, ComponentSchemaError);
    }
  }

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isSafeComponentName(value) {
    if (typeof value !== 'string') return false;
    return value === value.trim() && COMPONENT_NAME_RE.test(value) && !FORBIDDEN_COMPONENT_NAMES.has(value.toLowerCase());
  }

  function escapePointer(value) {
    return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function joinPointer(base, key) {
    return `${base || ''}/${escapePointer(key)}`;
  }

  function defineJsonProperty(target, key, value) {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  }

  function diagnostic(code, message, pointer = '', details, severity = 'error') {
    const result = { severity, code, message, pointer };
    if (details !== undefined) result.details = details;
    return result;
  }

  function cloneJson(value, seen = new Map()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) throw new ComponentSchemaError('E_COMPONENT_JSON_CIRCULAR', 'Component data must not contain circular references');
    const output = Array.isArray(value) ? [] : {};
    seen.set(value, output);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) output[index] = cloneJson(value[index], seen);
    } else {
      for (const key of Object.keys(value)) defineJsonProperty(output, key, cloneJson(value[key], seen));
    }
    seen.delete(value);
    return output;
  }

  function deepMerge(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) return cloneJson(override);
    const output = cloneJson(base);
    for (const key of Object.keys(override)) {
      const value = isPlainObject(output[key]) && isPlainObject(override[key])
        ? deepMerge(output[key], override[key])
        : cloneJson(override[key]);
      defineJsonProperty(output, key, value);
    }
    return output;
  }

  function deepFreeze(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
  }

  function sameValue(left, right, pairs = new Map()) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (pairs.get(left) === right) return true;
    pairs.set(left, right);
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index += 1) {
      if (leftKeys[index] !== rightKeys[index] || !sameValue(left[leftKeys[index]], right[rightKeys[index]], pairs)) return false;
    }
    return true;
  }

  function jsonSafetyDiagnostics(value, pointer = '', ancestors = new Set(), output = []) {
    const kind = typeof value;
    if (value === null || kind === 'string' || kind === 'boolean') return output;
    if (kind === 'number') {
      if (!Number.isFinite(value)) output.push(diagnostic('E_COMPONENT_JSON_NUMBER', 'JSON numbers must be finite', pointer));
      return output;
    }
    if (kind !== 'object') {
      output.push(diagnostic('E_COMPONENT_JSON_TYPE', `JSON does not support ${kind} values`, pointer));
      return output;
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      output.push(diagnostic('E_COMPONENT_JSON_OBJECT', 'Component objects must use a plain JSON object', pointer));
      return output;
    }
    if (ancestors.has(value)) {
      output.push(diagnostic('E_COMPONENT_JSON_CIRCULAR', 'Component data must not contain circular references', pointer));
      return output;
    }
    if (Object.getOwnPropertySymbols(value).length) {
      output.push(diagnostic('E_COMPONENT_JSON_SYMBOL_KEY', 'JSON objects must not contain symbol keys', pointer));
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!hasOwn(value, index)) output.push(diagnostic('E_COMPONENT_JSON_SPARSE_ARRAY', 'JSON arrays must not contain empty slots', joinPointer(pointer, index)));
        else jsonSafetyDiagnostics(value[index], joinPointer(pointer, index), ancestors, output);
      }
    } else {
      for (const key of Object.keys(value)) {
        let child;
        try { child = value[key]; }
        catch (error) {
          output.push(diagnostic('E_COMPONENT_JSON_ACCESS', 'Component property could not be read', joinPointer(pointer, key), { message: error && error.message }));
          continue;
        }
        jsonSafetyDiagnostics(child, joinPointer(pointer, key), ancestors, output);
      }
    }
    ancestors.delete(value);
    return output;
  }

  function valueMatchesType(value, expected, mode) {
    if (expected === 'null') return value === null;
    if (expected === 'array') return Array.isArray(value);
    if (expected === 'object') return isPlainObject(value);
    if (expected === 'integer') {
      if (Number.isInteger(value)) return true;
      return mode === 'compat' && typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value));
    }
    if (expected === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) return true;
      return mode === 'compat' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    }
    if (expected === 'boolean' && mode === 'compat' && (value === 'true' || value === 'false')) return true;
    return typeof value === expected;
  }

  function validateSchema(value, schema, pointer, output, options = {}) {
    if (!schema || typeof schema !== 'object') return output;
    const mode = options.mode || 'strict';
    if (Array.isArray(schema.anyOf)) {
      const attempts = schema.anyOf.map(candidate => {
        const errors = [];
        validateSchema(value, candidate, pointer, errors, options);
        return errors;
      });
      if (!attempts.some(errors => errors.length === 0)) {
        const best = attempts.sort((a, b) => a.length - b.length)[0];
        output.push(...(best.length ? best : [diagnostic('E_COMPONENT_SCHEMA', 'Value does not match any allowed schema', pointer)]));
      }
      return output;
    }
    if (schema.const !== undefined && !sameValue(value, schema.const)) {
      output.push(diagnostic('E_COMPONENT_CONST', `Value must equal ${JSON.stringify(schema.const)}`, pointer));
      return output;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(item => sameValue(item, value))) {
      output.push(diagnostic('E_COMPONENT_ENUM', `Value must be one of: ${schema.enum.join(', ')}`, pointer, { allowed: cloneJson(schema.enum) }));
      return output;
    }
    if (schema.type) {
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!allowed.some(type => valueMatchesType(value, type, mode))) {
        output.push(diagnostic('E_COMPONENT_TYPE', `Expected ${allowed.join(' or ')}`, pointer, { expected: allowed, actual: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value }));
        return output;
      }
    }
    if (typeof value === 'string') {
      if (schema.minLength != null && value.length < schema.minLength) output.push(diagnostic('E_COMPONENT_MIN_LENGTH', `String must have at least ${schema.minLength} characters`, pointer));
      if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) output.push(diagnostic('E_COMPONENT_PATTERN', `String must match ${schema.pattern}`, pointer));
    }
    if ((typeof value === 'number' && Number.isFinite(value)) || (mode === 'compat' && typeof value === 'string' && Number.isFinite(Number(value)))) {
      const numeric = Number(value);
      if (schema.minimum != null && numeric < schema.minimum) output.push(diagnostic('E_COMPONENT_MINIMUM', `Number must be at least ${schema.minimum}`, pointer));
      if (schema.maximum != null && numeric > schema.maximum) output.push(diagnostic('E_COMPONENT_MAXIMUM', `Number must be at most ${schema.maximum}`, pointer));
      if (schema.exclusiveMinimum != null && numeric <= schema.exclusiveMinimum) output.push(diagnostic('E_COMPONENT_EXCLUSIVE_MINIMUM', `Number must be greater than ${schema.exclusiveMinimum}`, pointer));
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) output.push(diagnostic('E_COMPONENT_MIN_ITEMS', `Array must contain at least ${schema.minItems} items`, pointer));
      if (schema.maxItems != null && value.length > schema.maxItems) output.push(diagnostic('E_COMPONENT_MAX_ITEMS', `Array must contain at most ${schema.maxItems} items`, pointer));
      if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, joinPointer(pointer, index), output, options));
    }
    if (isPlainObject(value)) {
      for (const key of schema.required || []) {
        if (!hasOwn(value, key)) output.push(diagnostic('E_COMPONENT_REQUIRED', `Missing required property: ${key}`, joinPointer(pointer, key), { property: key }));
      }
      const properties = schema.properties || {};
      for (const key of Object.keys(value)) {
        if (hasOwn(properties, key)) validateSchema(value[key], properties[key], joinPointer(pointer, key), output, options);
        else if (schema.additionalProperties === false) output.push(diagnostic('E_COMPONENT_ADDITIONAL_PROPERTY', `Unknown property: ${key}`, joinPointer(pointer, key)));
        else if (isPlainObject(schema.additionalProperties)) validateSchema(value[key], schema.additionalProperties, joinPointer(pointer, key), output, options);
      }
      if (schema.propertyNames && schema.propertyNames.pattern) {
        const expression = new RegExp(schema.propertyNames.pattern);
        for (const key of Object.keys(value)) if (!expression.test(key)) output.push(diagnostic('E_COMPONENT_PROPERTY_NAME', `Property name must match ${schema.propertyNames.pattern}`, joinPointer(pointer, key)));
      }
    }
    return output;
  }

  const number = (extra = {}) => ({ type: 'number', ...extra });
  const integer = (extra = {}) => ({ type: 'integer', ...extra });
  const string = (extra = {}) => ({ type: 'string', ...extra });
  const boolean = (extra = {}) => ({ type: 'boolean', ...extra });
  const nullableString = () => ({ type: ['string', 'null'] });
  const object = (properties = {}, extra = {}) => ({ type: 'object', properties, additionalProperties: true, ...extra });
  const profileSet = (authoring, runtime = authoring, snapshot = runtime) => ({ authoring, runtime, snapshot });

  const TAG_SCHEMA = object();
  const NAME_SCHEMA = object({ value: string() }, { required: ['value'] });
  const TRANSFORM_AUTHORING_SCHEMA = object({
    x: number(), y: number(), rotation: number(), scaleX: number(), scaleY: number(),
    rot: number(), sx: number(), sy: number()
  });
  const TRANSFORM_RUNTIME_SCHEMA = object({
    ...TRANSFORM_AUTHORING_SCHEMA.properties,
    world: { type: 'array', items: number(), minItems: 6, maxItems: 6 }
  });
  const SOURCE_RECT_SCHEMA = object({
    x: number(), y: number(), width: number({ exclusiveMinimum: 0 }), height: number({ exclusiveMinimum: 0 })
  });
  const RENDERABLE_SCHEMA = object({
    kind: string(), width: number({ minimum: 0 }), height: number({ minimum: 0 }), color: string(),
    assetId: nullableString(), imageSrc: nullableString(), layer: number(), visible: boolean(),
    frame: integer({ minimum: 0 }), sourceRect: SOURCE_RECT_SCHEMA
  });
  const RIGIDBODY_AUTHORING_SCHEMA = object({
    enabled: boolean(), type: { type: 'string', enum: ['static', 'dynamic', 'kinematic'] },
    mass: number({ exclusiveMinimum: 0 }), useAutoMass: boolean(), gravityScale: number(),
    linearDamping: number({ minimum: 0 }), angularDamping: number({ minimum: 0 }),
    fixedRotation: boolean(), bullet: boolean(), allowSleep: boolean(), sleeping: boolean(),
    velocity: object({ x: number(), y: number() }), velocityX: number(), velocityY: number(), angularVelocity: number()
  });
  const RIGIDBODY_RUNTIME_SCHEMA = object({
    ...RIGIDBODY_AUTHORING_SCHEMA.properties,
    inverseMass: number({ minimum: 0 }), inertia: number({ minimum: 0 }), inverseInertia: number({ minimum: 0 }),
    force: object({ x: number(), y: number() }), torque: number(), sleepTime: number({ minimum: 0 })
  });
  const COLLIDER_PROPERTIES = {
    id: string(), enabled: boolean(), shape: { type: 'string', enum: ['rectangle', 'box', 'circle', 'sphere'] },
    type: { type: 'string', enum: ['rectangle', 'box', 'circle', 'sphere'] },
    width: number({ exclusiveMinimum: 0 }), height: number({ exclusiveMinimum: 0 }), w: number({ exclusiveMinimum: 0 }), h: number({ exclusiveMinimum: 0 }),
    size: object({ x: number({ exclusiveMinimum: 0 }), y: number({ exclusiveMinimum: 0 }) }), radius: number({ exclusiveMinimum: 0 }),
    offsetX: number(), offsetY: number(), offset: object({ x: number(), y: number() }), rotation: number(), angle: number(),
    density: number({ exclusiveMinimum: 0 }), friction: number({ minimum: 0 }), restitution: number({ minimum: 0, maximum: 1 }),
    bounce: number({ minimum: 0, maximum: 1 }), isTrigger: boolean(), trigger: boolean(), sensor: boolean(),
    categoryBits: integer(), maskBits: integer(), groupIndex: integer(), category: integer(), mask: integer(), group: integer()
  };
  const COLLIDER_ITEM_SCHEMA = object(COLLIDER_PROPERTIES);
  const COLLIDER_RECORD_SCHEMA = object({
    ...COLLIDER_PROPERTIES,
    colliders: { type: 'array', items: COLLIDER_ITEM_SCHEMA },
    shapes: { type: 'array', items: COLLIDER_ITEM_SCHEMA }
  });
  const COLLIDER_SCHEMA = { anyOf: [COLLIDER_RECORD_SCHEMA, { type: 'array', items: COLLIDER_RECORD_SCHEMA }] };
  const COLLIDER_COMPONENT_TYPES = Object.freeze([
    'Collider', 'BoxCollider', 'BoxCollider2D', 'CircleCollider', 'CircleCollider2D'
  ]);
  const COLLIDER_COMPONENT_TYPE_SET = new Set(COLLIDER_COMPONENT_TYPES);

  function colliderFixtureEntries(value, pointer = '') {
    const fixtures = [];
    const visit = (entry, entryPointer) => {
      if (!isPlainObject(entry)) return;
      const nested = Array.isArray(entry.colliders)
        ? { key: 'colliders', value: entry.colliders }
        : (Array.isArray(entry.shapes) ? { key: 'shapes', value: entry.shapes } : null);
      if (nested) {
        const nestedPointer = joinPointer(entryPointer, nested.key);
        nested.value.forEach((fixture, index) => visit(fixture, joinPointer(nestedPointer, index)));
        return;
      }
      fixtures.push({ value: entry, pointer: entryPointer });
    };
    if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, joinPointer(pointer, index)));
    else visit(value, pointer);
    return fixtures;
  }

  function colliderIdDiagnostics(value, pointer = '') {
    const diagnostics = [];
    const seen = new Map();
    for (const fixture of colliderFixtureEntries(value, pointer)) {
      const id = fixture.value.id;
      // Missing and empty ids receive deterministic per-Entity runtime ids, so
      // only explicit ids can collide in the native fixture lookup.
      if (typeof id !== 'string' || !id) continue;
      const idPointer = joinPointer(fixture.pointer, 'id');
      if (seen.has(id)) {
        diagnostics.push(diagnostic(
          'E_COLLIDER_ID_DUPLICATE',
          `Duplicate Collider id within Entity: ${id}`,
          idPointer,
          { colliderId: id, firstPointer: seen.get(id) }
        ));
      } else seen.set(id, idPointer);
    }
    return diagnostics;
  }
  const PREFAB_OVERRIDE_OPERATION_SCHEMA = object({
    op: { type: 'string', enum: ['add', 'replace', 'remove'] },
    value: {}
  }, { required: ['op'] });
  const PREFAB_SCHEMA = object({
    // assetId is retained for the legacy flat `prefab: true` projection. The
    // remaining fields identify one concrete member of an expanded instance.
    assetId: nullableString(),
    prefabId: nullableString(),
    sourceEntityId: nullableString(),
    instanceRootId: nullableString(),
    prefabRevision: integer({ minimum: 0 }),
    overrides: object({}, { additionalProperties: true })
  });
  const CAMERA_SCHEMA = object({
    active: boolean(), zoom: number({ exclusiveMinimum: 0 }), viewportWidth: number({ minimum: 0 }), viewportHeight: number({ minimum: 0 }),
    near: number(), far: number(), clearColor: string()
  });
  const LIGHT_SCHEMA = object({ color: string(), intensity: number({ minimum: 0 }), radius: number({ minimum: 0 }), type: string(), enabled: boolean() });
  const SHADOW_SCHEMA = object({ opacity: number({ minimum: 0, maximum: 1 }), enabled: boolean(), color: string(), blur: number({ minimum: 0 }) });
  const ANIMATION_AUTHORING_SCHEMA = object({
    clipId: string(), clip: string(), autoplay: boolean(), playing: boolean(), time: number({ minimum: 0 }),
    duration: number({ minimum: 0 }), speed: number(), loop: boolean(), frameCount: integer({ minimum: 0 })
  });
  const ANIMATION_RUNTIME_SCHEMA = object({
    ...ANIMATION_AUTHORING_SCHEMA.properties,
    frame: number({ minimum: 0 }), sampledHitboxes: { type: 'array', items: { type: 'object' } }, completed: boolean()
  });
  const SKELETON_AUTHORING_SCHEMA = object({
    rootBoneId: string({ minLength: 1, pattern: '\\S' }),
    enabled: boolean(), solveIK: boolean(), debug: boolean()
  });
  const SKELETON_RUNTIME_SCHEMA = object({
    ...SKELETON_AUTHORING_SCHEMA.properties,
    pose: object(),
    boneMatrices: object({}, {
      additionalProperties: { type: 'array', items: number(), minItems: 6, maxItems: 6 }
    })
  });
  const BONE_SCHEMA = object({
    length: number({ minimum: 0 }), inheritRotation: boolean(), inheritScale: boolean(), color: string()
  }, { required: ['length'] });
  const IK_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    skeletonRootId: string({ minLength: 1, pattern: '\\S' }),
    bones: { type: 'array', items: string({ minLength: 1, pattern: '\\S' }), minItems: 1 },
    mix: number({ minimum: 0, maximum: 1 }),
    iterations: integer({ minimum: 1 }),
    tolerance: number({ minimum: 0 }),
    enabled: boolean(),
    bendDirection: { type: 'integer', enum: [-1, 1] }
  }, { required: ['skeletonRootId', 'bones'] });
  const SKIN_WEIGHT_SCHEMA = object({
    boneId: string({ minLength: 1, pattern: '\\S' }),
    weight: number({ minimum: 0 })
  }, { required: ['boneId', 'weight'] });
  const SKIN_VERTEX_SCHEMA = object({
    x: number(), y: number(),
    weights: { type: 'array', items: SKIN_WEIGHT_SCHEMA, minItems: 1 }
  }, { required: ['x', 'y', 'weights'] });
  const SKIN_AUTHORING_SCHEMA = object({
    skeletonRootId: string({ minLength: 1, pattern: '\\S' }),
    assetId: string({ minLength: 1, pattern: '\\S' }),
    vertices: { type: 'array', items: SKIN_VERTEX_SCHEMA },
    uvs: { type: 'array', items: number() },
    indices: { type: 'array', items: integer({ minimum: 0 }) }
  }, { required: ['skeletonRootId', 'vertices'] });
  const SKIN_RUNTIME_SCHEMA = object({
    ...SKIN_AUTHORING_SCHEMA.properties,
    deformedVertices: { type: 'array', items: object({ x: number(), y: number() }, { required: ['x', 'y'] }) }
  }, { required: SKIN_AUTHORING_SCHEMA.required });
  const TILEMAP_SCHEMA = object({
    tileWidth: number({ exclusiveMinimum: 0 }), tileHeight: number({ exclusiveMinimum: 0 }),
    width: integer({ minimum: 0 }), height: integer({ minimum: 0 }), tiles: { type: 'array', items: { type: 'array' } }, assetId: nullableString()
  });
  const PARTICLE_SCHEMA = object({
    name: string(), amount: integer({ minimum: 0 }), rate: number({ minimum: 0 }), lifetime: number({ minimum: 0 }), speed: number(),
    spread: number(), gravity: number(), radius: number({ minimum: 0 }), scale: number({ minimum: 0 }), opacity: number({ minimum: 0, maximum: 1 }),
    hue: number(), blend: string(), playing: boolean(), loop: boolean()
  });

  const COMPONENT_SCHEMAS = {
    Name: profileSet(NAME_SCHEMA),
    Transform: profileSet(TRANSFORM_AUTHORING_SCHEMA, TRANSFORM_RUNTIME_SCHEMA),
    Renderable: profileSet(RENDERABLE_SCHEMA),
    Rigidbody: profileSet(RIGIDBODY_AUTHORING_SCHEMA, RIGIDBODY_RUNTIME_SCHEMA),
    Collider: profileSet(COLLIDER_SCHEMA),
    Hidden: profileSet(TAG_SCHEMA),
    Locked: profileSet(TAG_SCHEMA),
    PrefabInstance: profileSet(PREFAB_SCHEMA),
    Camera: profileSet(CAMERA_SCHEMA),
    Light: profileSet(LIGHT_SCHEMA),
    ShadowCaster: profileSet(SHADOW_SCHEMA),
    Animation: profileSet(ANIMATION_AUTHORING_SCHEMA, ANIMATION_RUNTIME_SCHEMA),
    Skeleton: profileSet(SKELETON_AUTHORING_SCHEMA, SKELETON_RUNTIME_SCHEMA),
    Bone: profileSet(BONE_SCHEMA),
    IK: profileSet(IK_SCHEMA),
    Skin: profileSet(SKIN_AUTHORING_SCHEMA, SKIN_RUNTIME_SCHEMA),
    Tilemap: profileSet(TILEMAP_SCHEMA),
    ParticleEmitter: profileSet(PARTICLE_SCHEMA),
    BoxCollider: profileSet(COLLIDER_SCHEMA),
    BoxCollider2D: profileSet(COLLIDER_SCHEMA),
    CircleCollider: profileSet(COLLIDER_SCHEMA),
    CircleCollider2D: profileSet(COLLIDER_SCHEMA)
  };

  function makeComponentMapSchema(profile) {
    const properties = {};
    for (const type of Object.keys(COMPONENT_SCHEMAS)) properties[type] = COMPONENT_SCHEMAS[type][profile];
    for (const alias of ['RigidBody', 'Body']) properties[alias] = COMPONENT_SCHEMAS.Rigidbody[profile];
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${DATA_MODEL_ID}/component-map/${DATA_MODEL_VERSION}/${profile}`,
      title: `AH2D ${profile} Component Map`,
      type: 'object',
      properties,
      propertyNames: { pattern: COMPONENT_NAME_PATTERN },
      additionalProperties: { anyOf: [{ type: 'object' }, { type: 'array' }] }
    };
  }

  const PROFILE_SCHEMAS = {
    authoring: makeComponentMapSchema(PROFILES.AUTHORING),
    runtime: makeComponentMapSchema(PROFILES.RUNTIME),
    snapshot: makeComponentMapSchema(PROFILES.SNAPSHOT)
  };
  const COMPONENT_MAP_SCHEMA = PROFILE_SCHEMAS.authoring;
  const ENTITY_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${DATA_MODEL_ID}/entity/${DATA_MODEL_VERSION}`,
    title: 'AH2D Entity',
    type: 'object',
    required: ['id'],
    properties: {
      id: string({ minLength: 1, pattern: '\\S' }), name: string(), parentId: { type: ['string', 'null'] },
      components: COMPONENT_MAP_SCHEMA,
      x: number(), y: number(), rot: number(), rotation: number(), sx: number(), sy: number(), scaleX: number(), scaleY: number(),
      rigidbody: RIGIDBODY_AUTHORING_SCHEMA, rigidBody: RIGIDBODY_AUTHORING_SCHEMA, collider: COLLIDER_SCHEMA
    },
    additionalProperties: true
  };
  const PREFAB_ASSET_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    name: string(),
    rootEntityId: string({ minLength: 1, pattern: '\\S' }),
    revision: integer({ minimum: 0 }),
    entities: { type: 'array', items: ENTITY_SCHEMA, minItems: 1 }
  }, { required: ['id', 'rootEntityId', 'entities'] });
  const ANIMATION_KEYFRAME_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    frame: integer({ minimum: 0 }),
    value: {},
    easing: string()
  }, { required: ['id', 'frame', 'value'] });
  const ANIMATION_TRACK_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    type: string({ minLength: 1, pattern: '\\S' }),
    targetEntityId: string({ minLength: 1, pattern: '\\S' }),
    interpolation: string(),
    keyframes: { type: 'array', items: ANIMATION_KEYFRAME_SCHEMA }
  }, { required: ['id', 'type', 'keyframes'] });
  const ANIMATION_CLIP_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    name: string({ minLength: 1, pattern: '\\S' }),
    fps: number({ exclusiveMinimum: 0 }),
    frameCount: integer({ minimum: 1 }),
    loop: boolean(),
    speed: number(),
    targetEntityId: string({ minLength: 1, pattern: '\\S' }),
    tracks: { type: 'array', items: ANIMATION_TRACK_SCHEMA }
  }, { required: ['id', 'name', 'fps', 'frameCount', 'loop', 'tracks'] });
  const JSON_SCHEMAS = {
    components: COMPONENT_SCHEMAS,
    componentProfiles: PROFILE_SCHEMAS,
    componentMap: COMPONENT_MAP_SCHEMA,
    entity: ENTITY_SCHEMA,
    prefabOverrideOperation: PREFAB_OVERRIDE_OPERATION_SCHEMA,
    prefabAsset: PREFAB_ASSET_SCHEMA,
    animationKeyframe: ANIMATION_KEYFRAME_SCHEMA,
    animationTrack: ANIMATION_TRACK_SCHEMA,
    animationClip: ANIMATION_CLIP_SCHEMA
  };

  function animationSlug(value, fallback = 'animation') {
    const slug = String(value == null ? '' : value)
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || fallback;
  }

  function animationGeneratedId(base, used, fallback) {
    let candidate = animationSlug(base, fallback);
    let suffix = 2;
    while (used.has(candidate)) candidate = `${animationSlug(base, fallback)}-${suffix++}`;
    used.add(candidate);
    return candidate;
  }

  function normalizeAnimationClip(input, options = {}) {
    if (Number.isInteger(options)) options = { index: options };
    const source = isPlainObject(input) ? cloneJson(input) : {};
    const index = Number.isInteger(options.index) && options.index >= 0 ? options.index : 0;
    const output = source;
    const name = typeof source.name === 'string' && source.name.trim()
      ? source.name.trim()
      : (typeof source.id === 'string' && source.id.trim() ? source.id.trim() : `Animation ${index + 1}`);
    output.id = typeof source.id === 'string' && source.id.trim()
      ? source.id.trim()
      : animationSlug(name, `animation-${index + 1}`);
    output.name = name;
    output.fps = Number.isFinite(Number(source.fps)) && Number(source.fps) > 0 ? Number(source.fps) : 12;
    const legacyFrameCount = !Array.isArray(source.frames) ? Number(source.frames) : NaN;
    const authoredFrameCount = Number(source.frameCount);
    const sourceTracks = Array.isArray(source.tracks) ? source.tracks : [];
    const rootEvents = Array.isArray(source.events) ? source.events : [];
    const discoveredLastFrame = [...sourceTracks.flatMap(track => Array.isArray(track?.keyframes) ? track.keyframes : []), ...rootEvents]
      .reduce((last, keyframe) => Number.isInteger(Number(keyframe?.frame)) ? Math.max(last, Number(keyframe.frame)) : last, -1);
    output.frameCount = Number.isInteger(authoredFrameCount) && authoredFrameCount > 0
      ? authoredFrameCount
      : (Number.isInteger(legacyFrameCount) && legacyFrameCount > 0 ? legacyFrameCount : Math.max(1, discoveredLastFrame + 1));
    if (source.frames != null && !Array.isArray(source.frames)) delete output.frames;
    output.loop = typeof source.loop === 'boolean' ? source.loop : true;
    if (source.speed != null) output.speed = Number.isFinite(Number(source.speed)) ? Number(source.speed) : 1;

    const usedTrackIds = new Set();
    output.tracks = sourceTracks.filter(isPlainObject).map((rawTrack, trackIndex) => {
      const track = cloneJson(rawTrack);
      const authoredType = typeof track.type === 'string' && track.type.trim() ? track.type.trim() : 'property';
      const canonicalType = authoredType.toLowerCase();
      const type = ANIMATION_TRACK_TYPES.includes(canonicalType) ? canonicalType : authoredType;
      track.type = type;
      if (typeof track.id === 'string' && track.id.trim()) {
        track.id = track.id.trim();
        usedTrackIds.add(track.id);
      } else track.id = animationGeneratedId(type, usedTrackIds, `track-${trackIndex + 1}`);
      if (typeof track.interpolation !== 'string' || !track.interpolation.trim()) {
        track.interpolation = ['position', 'rotation', 'bone', 'ik'].includes(type) ? 'linear' : 'step';
      }
      const usedKeyframeIds = new Set();
      track.keyframes = (Array.isArray(rawTrack.keyframes) ? rawTrack.keyframes : [])
        .filter(isPlainObject)
        .map((rawKeyframe, keyframeIndex) => {
          const keyframe = cloneJson(rawKeyframe);
          keyframe.frame = Number.isFinite(Number(keyframe.frame)) ? Number(keyframe.frame) : 0;
          if (typeof keyframe.id === 'string' && keyframe.id.trim()) {
            keyframe.id = keyframe.id.trim();
            usedKeyframeIds.add(keyframe.id);
          } else keyframe.id = animationGeneratedId(`${track.id}-${keyframe.frame}`, usedKeyframeIds, `key-${keyframeIndex + 1}`);
          if (type === 'sprite' && isPlainObject(keyframe.value)) {
            const hasCanonicalFrame = hasOwn(keyframe.value, 'frame');
            const hasLegacyFrame = hasOwn(keyframe.value, 'spriteFrame');
            if (hasCanonicalFrame || hasLegacyFrame) {
              const authoredFrame = hasCanonicalFrame ? keyframe.value.frame : keyframe.value.spriteFrame;
              keyframe.value.frame = Number.isInteger(Number(authoredFrame)) ? Number(authoredFrame) : authoredFrame;
            }
            if (hasLegacyFrame) delete keyframe.value.spriteFrame;
          }
          if ((type === 'bone' || type === 'ik') && isPlainObject(keyframe.value)) {
            const numericFields = type === 'bone'
              ? ['x', 'y', 'rotation', 'scaleX', 'scaleY']
              : ['x', 'y', 'mix', 'iterations', 'tolerance', 'bendDirection'];
            for (const field of numericFields) {
              if (hasOwn(keyframe.value, field) && Number.isFinite(Number(keyframe.value[field]))) {
                keyframe.value[field] = Number(keyframe.value[field]);
              }
            }
          }
          return keyframe;
        })
        .sort((left, right) => left.frame - right.frame);
      return track;
    });

    if (rootEvents.length) {
      let eventTrack = output.tracks.find(track => track.type === 'event');
      if (!eventTrack) {
        const id = animationGeneratedId('events', usedTrackIds, 'events');
        eventTrack = { id, type: 'event', interpolation: 'step', keyframes: [] };
        output.tracks.push(eventTrack);
      }
      const usedEventIds = new Set(eventTrack.keyframes.map(keyframe => keyframe.id));
      for (let eventIndex = 0; eventIndex < rootEvents.length; eventIndex += 1) {
        const rawEvent = rootEvents[eventIndex];
        if (!isPlainObject(rawEvent)) continue;
        const frame = Number.isFinite(Number(rawEvent.frame)) ? Number(rawEvent.frame) : 0;
        const keyframe = cloneJson(rawEvent);
        const value = isPlainObject(rawEvent.value)
          ? cloneJson(rawEvent.value)
          : {
              name: typeof rawEvent.name === 'string' ? rawEvent.name : 'Event',
              ...(hasOwn(rawEvent, 'payload') ? { payload: cloneJson(rawEvent.payload) } : {})
            };
        keyframe.id = typeof rawEvent.id === 'string' && rawEvent.id.trim()
          ? rawEvent.id.trim()
          : animationGeneratedId(`event-${frame}`, usedEventIds, `event-${eventIndex + 1}`);
        usedEventIds.add(keyframe.id);
        keyframe.frame = frame;
        keyframe.value = value;
        delete keyframe.name;
        delete keyframe.payload;
        eventTrack.keyframes.push(keyframe);
      }
      eventTrack.keyframes.sort((left, right) => left.frame - right.frame);
    }
    if (Array.isArray(source.events)) delete output.events;
    return output;
  }

  function normalizeAnimationClips(input, options = {}) {
    const source = Array.isArray(input) ? input : [];
    const entries = source
      .map((clip, index) => ({ clip, index }))
      .filter(entry => isPlainObject(entry.clip));
    const reservedIds = new Set(entries
      .map(entry => typeof entry.clip.id === 'string' ? entry.clip.id.trim() : '')
      .filter(Boolean));
    const usedIds = new Set(reservedIds);
    return entries.map(({ clip: rawClip, index }) => {
      const clip = normalizeAnimationClip(rawClip, { ...options, index });
      const hasExplicitId = typeof rawClip.id === 'string' && Boolean(rawClip.id.trim());
      if (!hasExplicitId) {
        clip.id = animationGeneratedId(clip.id, usedIds, `animation-${index + 1}`);
      }
      return clip;
    });
  }

  function animationEase(value, easing) {
    const t = Math.max(0, Math.min(1, value));
    if (easing === 'ease-in') return t * t;
    if (easing === 'ease-out') return 1 - ((1 - t) * (1 - t));
    if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    return t;
  }

  function interpolateAnimationValue(type, left, right, amount) {
    const t = animationEase(amount, left.easing);
    if (type === 'rotation') {
      if (Number.isFinite(Number(left.value)) && Number.isFinite(Number(right.value))) {
        return Number(left.value) + (Number(right.value) - Number(left.value)) * t;
      }
      if (isPlainObject(left.value) && isPlainObject(right.value) && Number.isFinite(Number(left.value.rotation)) && Number.isFinite(Number(right.value.rotation))) {
        return { ...cloneJson(left.value), rotation: Number(left.value.rotation) + (Number(right.value.rotation) - Number(left.value.rotation)) * t };
      }
    }
    if (type === 'position' && isPlainObject(left.value) && isPlainObject(right.value)) {
      const value = cloneJson(left.value);
      for (const axis of ['x', 'y']) {
        if (Number.isFinite(Number(left.value[axis])) && Number.isFinite(Number(right.value[axis]))) {
          value[axis] = Number(left.value[axis]) + (Number(right.value[axis]) - Number(left.value[axis])) * t;
        }
      }
      return value;
    }
    if ((type === 'bone' || type === 'ik') && isPlainObject(left.value) && isPlainObject(right.value)) {
      const value = cloneJson(left.value);
      const numericFields = type === 'bone'
        ? ['x', 'y', 'rotation', 'scaleX', 'scaleY']
        : ['x', 'y', 'mix', 'tolerance'];
      for (const field of numericFields) {
        if (animationFiniteNumber(left.value[field], true) && animationFiniteNumber(right.value[field], true)) {
          value[field] = Number(left.value[field]) + (Number(right.value[field]) - Number(left.value[field])) * t;
        }
      }
      return value;
    }
    return cloneJson(left.value);
  }

  function sampleAnimationClip(input, timeOrFrame = 0, options = {}) {
    const clip = normalizeAnimationClip(input, options.index || 0);
    const fps = clip.fps;
    const frameCount = clip.frameCount;
    const duration = frameCount / fps;
    const requested = Number.isFinite(Number(timeOrFrame)) ? Number(timeOrFrame) : 0;
    const rawFrame = options.unit === 'frame' ? requested : requested * fps;
    const shouldLoop = options.loop == null ? clip.loop : Boolean(options.loop);
    const sampleFrame = shouldLoop
      ? ((rawFrame % frameCount) + frameCount) % frameCount
      : Math.max(0, Math.min(frameCount - 1, rawFrame));
    const sampleTime = options.unit === 'frame'
      ? sampleFrame / fps
      : (shouldLoop ? sampleFrame / fps : Math.max(0, Math.min(duration, requested)));
    const sampledTracks = [];
    const events = [];
    const values = {};
    for (const track of clip.tracks) {
      const keyframes = track.keyframes.filter(keyframe => Number.isFinite(keyframe.frame));
      if (!keyframes.length) continue;
      if (track.type === 'event') {
        for (const keyframe of keyframes.filter(item => Math.abs(item.frame - sampleFrame) <= 1e-7)) {
          const value = cloneJson(keyframe.value);
          events.push({
            trackId: track.id,
            keyframeId: keyframe.id,
            targetEntityId: track.targetEntityId || clip.targetEntityId || null,
            frame: keyframe.frame,
            time: keyframe.frame / fps,
            value,
            ...(isPlainObject(value) && typeof value.name === 'string' ? { name: value.name } : {}),
            ...(isPlainObject(value) && hasOwn(value, 'payload') ? { payload: cloneJson(value.payload) } : {})
          });
        }
      }
      let left = null;
      let right = null;
      for (const keyframe of keyframes) {
        if (keyframe.frame <= sampleFrame) left = keyframe;
        else { right = keyframe; break; }
      }
      if (!left) continue;
      if (track.type === 'event' && Math.abs(left.frame - sampleFrame) > 1e-7) continue;
      const interpolation = String(track.interpolation || (['position', 'rotation', 'bone', 'ik'].includes(track.type) ? 'linear' : 'step')).toLowerCase();
      let value = cloneJson(left.value);
      if (interpolation !== 'step' && right && right.frame > left.frame && ['position', 'rotation', 'bone', 'ik'].includes(track.type)) {
        value = interpolateAnimationValue(track.type, left, right, (sampleFrame - left.frame) / (right.frame - left.frame));
      }
      const sampled = {
        trackId: track.id,
        type: track.type,
        targetEntityId: track.targetEntityId || clip.targetEntityId || null,
        interpolation,
        keyframeId: left.id,
        value
      };
      sampledTracks.push(sampled);
      defineJsonProperty(values, track.id, cloneJson(value));
    }
    return {
      clipId: clip.id,
      time: sampleTime,
      frame: sampleFrame,
      frameIndex: Math.min(frameCount - 1, Math.floor(sampleFrame)),
      duration,
      tracks: sampledTracks,
      events,
      values
    };
  }

  function animationKnownEntityRecords(document, codec) {
    const records = new Map();
    const add = (reference, entity) => {
      if (typeof reference !== 'string' || !reference.trim()) return;
      const matches = records.get(reference) || [];
      matches.push(entity);
      records.set(reference, matches);
    };
    for (const collection of animationEntityCollections(document)) {
      for (const entity of collection.entities) {
        if (!isPlainObject(entity)) continue;
        add(entity.id, entity);
        let marker;
        try { marker = codec.resolve(entity, 'PrefabInstance'); }
        catch (_) { marker = null; }
        if (marker?.found && isPlainObject(marker.value)) add(marker.value.sourceEntityId, entity);
      }
    }
    return records;
  }

  function animationTargetHasComponent(records, targetId, type, codec) {
    return (records.get(targetId) || []).some(entity => {
      try { return codec.resolve(entity, type).found; }
      catch (_) { return false; }
    });
  }

  function animationBindingContexts(document, codec) {
    const bindings = [];
    for (const collection of animationEntityCollections(document)) {
      const records = [];
      const byId = new Map();
      collection.entities.forEach((entity, entityIndex) => {
        if (!isPlainObject(entity)) return;
        const id = typeof entity.id === 'string' && entity.id.trim() ? entity.id : '';
        const record = {
          entity,
          id,
          pointer: `${collection.pointer}/${entityIndex}`,
          marker: null
        };
        records.push(record);
        if (id && !byId.has(id)) byId.set(id, record);
      });

      const instanceGroups = new Map();
      for (const record of records) {
        let marker;
        try { marker = codec.resolve(record.entity, 'PrefabInstance'); }
        catch (_) { marker = null; }
        const value = marker?.found && isPlainObject(marker.value) ? marker.value : null;
        if (!value || typeof value.prefabId !== 'string' || !value.prefabId.trim() ||
            typeof value.instanceRootId !== 'string' || !value.instanceRootId.trim() ||
            typeof value.sourceEntityId !== 'string' || !value.sourceEntityId.trim()) continue;
        record.marker = value;
        const groupKey = `${value.prefabId}\u0000${value.instanceRootId}`;
        const group = instanceGroups.get(groupKey) || new Map();
        if (!group.has(value.sourceEntityId)) group.set(value.sourceEntityId, record);
        instanceGroups.set(groupKey, group);
      }

      for (const record of records) {
        let resolved;
        try { resolved = codec.resolve(record.entity, 'Animation'); }
        catch (_) { resolved = null; }
        if (!resolved?.found || !isPlainObject(resolved.value)) continue;
        bindings.push({
          entity: record.entity,
          entityId: record.id,
          pointer: `${record.pointer}${pointerForStorage(resolved.storage)}`,
          animation: resolved.value,
          resolveReference(authoredId) {
            const reference = typeof authoredId === 'string' ? authoredId.trim() : '';
            if (!reference) return null;
            if (record.marker) {
              const group = instanceGroups.get(`${record.marker.prefabId}\u0000${record.marker.instanceRootId}`);
              // Connected instances author Skeleton/Animation references in
              // prefab source-ID space. Never escape into another instance or
              // an unrelated concrete Entity with the same text ID.
              return group?.get(reference) || null;
            }
            return byId.get(reference) || null;
          }
        });
      }
    }
    return bindings;
  }

  function animationBindingMatchesClip(binding, clipId, clipName, uniqueClipNames) {
    const stable = typeof binding.animation.clipId === 'string' ? binding.animation.clipId.trim() : '';
    if (stable) return Boolean(clipId) && stable === clipId;
    const legacy = typeof binding.animation.clip === 'string' ? binding.animation.clip.trim() : '';
    if (!legacy) return false;
    if (clipId && legacy === clipId) return true;
    const foldedName = typeof clipName === 'string' ? clipName.toLocaleLowerCase() : '';
    return Boolean(foldedName) && legacy.toLocaleLowerCase() === foldedName && uniqueClipNames.get(foldedName) === 1;
  }

  function animationRecordHasComponent(record, type, codec) {
    if (!record) return false;
    try { return codec.resolve(record.entity, type).found; }
    catch (_) { return false; }
  }

  function animationLegacyDiagnostic(output, strict, message, pointer, details) {
    output.push(diagnostic(strict ? 'E_ANIMATION_LEGACY' : 'W_ANIMATION_LEGACY', message, pointer, details, strict ? 'error' : 'warning'));
  }

  function animationFiniteNumber(value, strict) {
    if (typeof value === 'number') return Number.isFinite(value);
    return !strict && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
  }

  function animationInteger(value, strict) {
    if (typeof value === 'number') return Number.isInteger(value);
    return !strict && typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value));
  }

  function validateAnimationValue(type, value, pointer, output, strict) {
    output.push(...jsonSafetyDiagnostics(value, pointer));
    if (type === 'position') {
      if (!isPlainObject(value) || !animationFiniteNumber(value.x, strict) || !animationFiniteNumber(value.y, strict)) {
        output.push(diagnostic('E_ANIMATION_POSITION_VALUE', 'Position keyframe value must contain finite x and y numbers', pointer));
      }
    } else if (type === 'rotation') {
      const valid = animationFiniteNumber(value, strict) || (isPlainObject(value) && animationFiniteNumber(value.rotation, strict));
      if (!valid) output.push(diagnostic('E_ANIMATION_ROTATION_VALUE', 'Rotation keyframe value must be a finite number or an object with finite rotation', pointer));
    } else if (type === 'sprite') {
      if (!isPlainObject(value)) output.push(diagnostic('E_ANIMATION_SPRITE_VALUE', 'Sprite keyframe value must be an object', pointer));
      else {
        const frameKey = hasOwn(value, 'frame') ? 'frame' : (hasOwn(value, 'spriteFrame') ? 'spriteFrame' : null);
        if (frameKey && (!animationInteger(value[frameKey], strict) || Number(value[frameKey]) < 0)) {
          output.push(diagnostic('E_ANIMATION_SPRITE_FRAME', 'Sprite frame must be a non-negative integer', joinPointer(pointer, frameKey)));
        }
        if (value.sourceRect != null) {
          const rect = value.sourceRect;
          if (!isPlainObject(rect) || !animationFiniteNumber(rect.x, strict) || !animationFiniteNumber(rect.y, strict) || !animationFiniteNumber(rect.width, strict) || Number(rect.width) <= 0 || !animationFiniteNumber(rect.height, strict) || Number(rect.height) <= 0) {
            output.push(diagnostic('E_ANIMATION_SOURCE_RECT', 'sourceRect must contain finite x/y and positive width/height', joinPointer(pointer, 'sourceRect')));
          }
        }
      }
    } else if (type === 'event') {
      if (!isPlainObject(value) || typeof value.name !== 'string' || !value.name.trim()) output.push(diagnostic('E_ANIMATION_EVENT_VALUE', 'Event keyframe value must have a non-empty name', pointer));
    } else if (type === 'hitbox') {
      if (!isPlainObject(value)) output.push(diagnostic('E_ANIMATION_HITBOX_VALUE', 'Hitbox keyframe value must be an object', pointer));
      else if (value.colliderId != null && (typeof value.colliderId !== 'string' || !value.colliderId.trim())) output.push(diagnostic('E_ANIMATION_HITBOX_ID', 'Hitbox colliderId must be a non-empty string', joinPointer(pointer, 'colliderId')));
    } else if (type === 'bone') {
      const fields = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];
      if (!isPlainObject(value) || !fields.some(field => hasOwn(value, field))) {
        output.push(diagnostic('E_ANIMATION_BONE_VALUE', 'Bone keyframe value must contain at least one transform field', pointer));
      } else {
        for (const field of fields) {
          if (hasOwn(value, field) && !animationFiniteNumber(value[field], strict)) {
            output.push(diagnostic('E_ANIMATION_BONE_VALUE', `${field} must be a finite number`, joinPointer(pointer, field)));
          }
        }
      }
    } else if (type === 'ik') {
      const fields = ['x', 'y', 'mix', 'iterations', 'tolerance', 'enabled', 'bendDirection'];
      if (!isPlainObject(value) || !fields.some(field => hasOwn(value, field))) {
        output.push(diagnostic('E_ANIMATION_IK_VALUE', 'IK keyframe value must contain at least one target or constraint field', pointer));
      } else {
        for (const field of ['x', 'y']) if (hasOwn(value, field) && !animationFiniteNumber(value[field], strict)) {
          output.push(diagnostic('E_ANIMATION_IK_VALUE', `${field} must be a finite number`, joinPointer(pointer, field)));
        }
        if (hasOwn(value, 'mix') && (!animationFiniteNumber(value.mix, strict) || Number(value.mix) < 0 || Number(value.mix) > 1)) {
          output.push(diagnostic('E_ANIMATION_IK_VALUE', 'mix must be between 0 and 1', joinPointer(pointer, 'mix')));
        }
        if (hasOwn(value, 'iterations') && (!animationInteger(value.iterations, strict) || Number(value.iterations) < 1)) {
          output.push(diagnostic('E_ANIMATION_IK_VALUE', 'iterations must be a positive integer', joinPointer(pointer, 'iterations')));
        }
        if (hasOwn(value, 'tolerance') && (!animationFiniteNumber(value.tolerance, strict) || Number(value.tolerance) < 0)) {
          output.push(diagnostic('E_ANIMATION_IK_VALUE', 'tolerance must be a non-negative finite number', joinPointer(pointer, 'tolerance')));
        }
        if (hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean') {
          output.push(diagnostic('E_ANIMATION_IK_VALUE', 'enabled must be boolean', joinPointer(pointer, 'enabled')));
        }
        if (hasOwn(value, 'bendDirection') && ![-1, 1].includes(Number(value.bendDirection))) {
          output.push(diagnostic('E_ANIMATION_IK_VALUE', 'bendDirection must be -1 or 1', joinPointer(pointer, 'bendDirection')));
        } else if (hasOwn(value, 'bendDirection') && strict && typeof value.bendDirection !== 'number') {
          output.push(diagnostic('E_ANIMATION_IK_VALUE', 'bendDirection must be -1 or 1', joinPointer(pointer, 'bendDirection')));
        }
      }
    }
  }

  function animationEntityCollections(document) {
    if (!isPlainObject(document) || document.format === 'AH2D.Animation') return [];
    const collections = [];
    if (Array.isArray(document.scenes)) {
      document.scenes.forEach((scene, sceneIndex) => collections.push({
        entities: Array.isArray(scene?.objects) ? scene.objects : [],
        pointer: `/scenes/${sceneIndex}/objects`
      }));
    } else if (Array.isArray(document.entities)) collections.push({ entities: document.entities, pointer: '/entities' });
    else if (Array.isArray(document.scene)) collections.push({ entities: document.scene, pointer: '/scene' });
    for (let prefabIndex = 0; prefabIndex < (Array.isArray(document.prefabs) ? document.prefabs.length : 0); prefabIndex += 1) {
      const prefab = document.prefabs[prefabIndex];
      collections.push({
        entities: Array.isArray(prefab?.entities) ? prefab.entities : [],
        pointer: `/prefabs/${prefabIndex}/entities`
      });
    }
    return collections;
  }

  function validateAnimationComponentReferences(document, clipIds, clipNames, output, options = {}) {
    const strict = Boolean(options.strict);
    const codec = options.entityCodec instanceof EntityCodec ? options.entityCodec : createDefaultEntityCodec();
    for (const collection of animationEntityCollections(document)) {
      collection.entities.forEach((entity, entityIndex) => {
        if (!isPlainObject(entity)) return;
        let resolved;
        try { resolved = codec.resolve(entity, 'Animation'); }
        catch (_) { return; }
        if (!resolved.found || !isPlainObject(resolved.value)) return;
        const animation = resolved.value;
        const pointer = `${collection.pointer}/${entityIndex}${pointerForStorage(resolved.storage)}`;
        const clipId = typeof animation.clipId === 'string' ? animation.clipId.trim() : '';
        const legacyClip = typeof animation.clip === 'string' ? animation.clip.trim() : '';
        if (clipId) {
          if (!clipIds.has(clipId)) output.push(diagnostic(
            'E_ANIMATION_CLIP_REFERENCE',
            `Animation Clip does not exist: ${clipId}`,
            joinPointer(pointer, 'clipId'),
            { clipId }
          ));
          return;
        }
        if (legacyClip) {
          const idMatch = clipIds.has(legacyClip);
          const nameMatches = clipNames.get(legacyClip.toLocaleLowerCase()) || [];
          if (!idMatch && nameMatches.length !== 1) {
            output.push(diagnostic(
              strict ? 'E_ANIMATION_CLIP_REFERENCE' : 'W_ANIMATION_COMPONENT_LEGACY',
              nameMatches.length > 1 ? `Legacy Animation Clip name is ambiguous: ${legacyClip}` : `Legacy Animation component does not resolve a Clip asset: ${legacyClip}`,
              joinPointer(pointer, 'clip'),
              { clip: legacyClip, matches: nameMatches.length },
              strict ? 'error' : 'warning'
            ));
          } else {
            output.push(diagnostic(
              strict ? 'E_ANIMATION_COMPONENT_LEGACY' : 'W_ANIMATION_COMPONENT_LEGACY',
              'Animation.clip is legacy; use the stable Animation.clipId field',
              joinPointer(pointer, 'clip'),
              { clip: legacyClip },
              strict ? 'error' : 'warning'
            ));
          }
          return;
        }
        output.push(diagnostic(
          strict ? 'E_ANIMATION_COMPONENT_CLIP' : 'W_ANIMATION_COMPONENT_LEGACY',
          'Animation component has no clipId and will run only as a legacy clock',
          pointer,
          undefined,
          strict ? 'error' : 'warning'
        ));
      });
    }
  }

  function validateAnimationDocument(document, options = {}) {
    const output = [];
    const strict = Boolean(options.strict);
    // Runtime ECS snapshots intentionally carry only concrete Entity state.
    // Animation components retain their stable clipId so a Play snapshot can
    // reconnect to the authoring library on restore, but the reusable Clip
    // definitions themselves are not part of the lossy snapshot contract.
    const definitionFreeEcsSnapshot = isPlainObject(document) &&
      Number(document.version) === 3 && Array.isArray(document.entities) &&
      document.animations == null;
    let animations;
    let basePointer = '/animations';
    if (Array.isArray(document)) animations = document;
    else if (isPlainObject(document) && document.format === 'AH2D.Animation') { animations = [document]; basePointer = ''; }
    else if (isPlainObject(document)) animations = document.animations == null ? [] : document.animations;
    else return [diagnostic('E_ANIMATION_DOCUMENT', 'Animation document must be a plain object or array', '')];
    if (!Array.isArray(animations)) return [diagnostic('E_ANIMATIONS_TYPE', 'animations must be an array', basePointer)];
    const clipIds = new Map();
    const clipNames = new Map();
    const hasEntityContext = isPlainObject(document) && document.format !== 'AH2D.Animation';
    const codec = options.entityCodec instanceof EntityCodec ? options.entityCodec : createDefaultEntityCodec();
    const knownEntityRecords = hasEntityContext ? animationKnownEntityRecords(document, codec) : new Map();
    const knownEntityIds = new Set(knownEntityRecords.keys());
    const animationBindings = hasEntityContext ? animationBindingContexts(document, codec) : [];
    const uniqueClipNames = new Map();
    for (const candidate of animations) {
      const candidateName = isPlainObject(candidate) && typeof candidate.name === 'string'
        ? candidate.name.trim().toLocaleLowerCase()
        : '';
      if (candidateName) uniqueClipNames.set(candidateName, (uniqueClipNames.get(candidateName) || 0) + 1);
    }
    animations.forEach((clip, clipIndex) => {
      const pointer = basePointer ? joinPointer(basePointer, clipIndex) : '';
      if (!isPlainObject(clip)) { output.push(diagnostic('E_ANIMATION_CLIP_TYPE', 'Animation Clip must be a plain object', pointer)); return; }
      output.push(...jsonSafetyDiagnostics(clip, pointer));
      const id = typeof clip.id === 'string' ? clip.id.trim() : '';
      if (!id) animationLegacyDiagnostic(output, strict, 'Legacy Animation Clip has no stable id', joinPointer(pointer, 'id'));
      else if (clipIds.has(id)) output.push(diagnostic('E_ANIMATION_CLIP_ID_DUPLICATE', `Duplicate Animation Clip id: ${id}`, joinPointer(pointer, 'id'), { firstPointer: clipIds.get(id) }));
      else clipIds.set(id, joinPointer(pointer, 'id'));
      const name = typeof clip.name === 'string' ? clip.name.trim() : '';
      if (!name) output.push(diagnostic('E_ANIMATION_CLIP_NAME', 'Animation Clip name must be a non-empty string', joinPointer(pointer, 'name')));
      else {
        const folded = name.toLocaleLowerCase();
        const matches = clipNames.get(folded) || [];
        if (matches.length) output.push(diagnostic(strict ? 'E_ANIMATION_CLIP_NAME_DUPLICATE' : 'W_ANIMATION_CLIP_NAME_DUPLICATE', `Duplicate Animation Clip name: ${name}`, joinPointer(pointer, 'name'), { firstPointer: matches[0] }, strict ? 'error' : 'warning'));
        matches.push(joinPointer(pointer, 'name'));
        clipNames.set(folded, matches);
      }
      const clipBindings = animationBindings.filter(binding => animationBindingMatchesClip(binding, id, name, uniqueClipNames));
      const resolvedClipTargets = new Map();
      if (!animationFiniteNumber(clip.fps, strict) || Number(clip.fps) <= 0) output.push(diagnostic('E_ANIMATION_FPS', 'Animation Clip fps must be a number greater than zero', joinPointer(pointer, 'fps')));
      let frameCount = clip.frameCount;
      if (frameCount == null && clip.frames != null && !Array.isArray(clip.frames)) {
        frameCount = clip.frames;
        animationLegacyDiagnostic(output, strict, 'Legacy frames field must be migrated to frameCount', joinPointer(pointer, 'frames'));
      }
      if (!animationInteger(frameCount, strict) || Number(frameCount) < 1) output.push(diagnostic('E_ANIMATION_FRAME_COUNT', 'Animation Clip frameCount must be a positive integer', joinPointer(pointer, clip.frameCount == null ? 'frames' : 'frameCount')));
      else frameCount = Number(frameCount);
      if (typeof clip.loop !== 'boolean') output.push(diagnostic('E_ANIMATION_LOOP', 'Animation Clip loop must be boolean', joinPointer(pointer, 'loop')));
      if (clip.speed != null && !animationFiniteNumber(clip.speed, strict)) output.push(diagnostic('E_ANIMATION_SPEED', 'Animation Clip speed must be a finite number', joinPointer(pointer, 'speed')));
      if (clip.targetEntityId != null) {
        if (typeof clip.targetEntityId !== 'string' || !clip.targetEntityId.trim()) output.push(diagnostic('E_ANIMATION_TARGET_ID', 'targetEntityId must be a non-empty string', joinPointer(pointer, 'targetEntityId')));
        else if (clipBindings.length) {
          for (const binding of clipBindings) {
            const target = binding.resolveReference(clip.targetEntityId);
            resolvedClipTargets.set(binding, target);
            if (!target) output.push(diagnostic(
              'E_ANIMATION_TARGET_MISSING',
              `Animation target Entity does not exist in the bound Entity scope: ${clip.targetEntityId}`,
              joinPointer(pointer, 'targetEntityId'),
              { targetEntityId: clip.targetEntityId, animationEntityId: binding.entityId, animationPointer: binding.pointer }
            ));
          }
        } else if (hasEntityContext && !knownEntityIds.has(clip.targetEntityId)) output.push(diagnostic('E_ANIMATION_TARGET_MISSING', `Animation target Entity does not exist: ${clip.targetEntityId}`, joinPointer(pointer, 'targetEntityId')));
      }
      let tracks = clip.tracks;
      if (!Array.isArray(tracks)) {
        if (Array.isArray(clip.events) || clip.frames != null) {
          animationLegacyDiagnostic(output, strict, 'Legacy Animation Clip must be migrated to tracks', joinPointer(pointer, 'tracks'));
          tracks = [];
        } else {
          output.push(diagnostic('E_ANIMATION_TRACKS', 'Animation Clip tracks must be an array', joinPointer(pointer, 'tracks')));
          tracks = [];
        }
      }
      if (Array.isArray(clip.events)) animationLegacyDiagnostic(output, strict, 'Legacy root events must be migrated to an event track', joinPointer(pointer, 'events'));
      const trackIds = new Map();
      tracks.forEach((track, trackIndex) => {
        const trackPointer = joinPointer(joinPointer(pointer, 'tracks'), trackIndex);
        if (!isPlainObject(track)) { output.push(diagnostic('E_ANIMATION_TRACK_TYPE', 'Animation track must be a plain object', trackPointer)); return; }
        const trackId = typeof track.id === 'string' ? track.id.trim() : '';
        if (!trackId) animationLegacyDiagnostic(output, strict, 'Legacy Animation track has no stable id', joinPointer(trackPointer, 'id'));
        else if (trackIds.has(trackId)) output.push(diagnostic('E_ANIMATION_TRACK_ID_DUPLICATE', `Duplicate Animation track id: ${trackId}`, joinPointer(trackPointer, 'id'), { firstPointer: trackIds.get(trackId) }));
        else trackIds.set(trackId, joinPointer(trackPointer, 'id'));
        const authoredType = typeof track.type === 'string' ? track.type.trim() : '';
        const type = authoredType.toLowerCase();
        if (!authoredType) output.push(diagnostic('E_ANIMATION_TRACK_KIND', 'Animation track type must be a non-empty string', joinPointer(trackPointer, 'type')));
        if (track.interpolation != null && typeof track.interpolation !== 'string') output.push(diagnostic('E_ANIMATION_INTERPOLATION', 'Animation track interpolation must be a string', joinPointer(trackPointer, 'interpolation')));
        if (track.targetEntityId != null) {
          if (typeof track.targetEntityId !== 'string' || !track.targetEntityId.trim()) output.push(diagnostic('E_ANIMATION_TARGET_ID', 'targetEntityId must be a non-empty string', joinPointer(trackPointer, 'targetEntityId')));
          else if (clipBindings.length) {
            for (const binding of clipBindings) if (!binding.resolveReference(track.targetEntityId)) output.push(diagnostic(
              'E_ANIMATION_TARGET_MISSING',
              `Animation target Entity does not exist in the bound Entity scope: ${track.targetEntityId}`,
              joinPointer(trackPointer, 'targetEntityId'),
              { targetEntityId: track.targetEntityId, animationEntityId: binding.entityId, animationPointer: binding.pointer }
            ));
          } else if (hasEntityContext && !knownEntityIds.has(track.targetEntityId)) output.push(diagnostic('E_ANIMATION_TARGET_MISSING', `Animation target Entity does not exist: ${track.targetEntityId}`, joinPointer(trackPointer, 'targetEntityId')));
        }
        if (hasEntityContext && (type === 'bone' || type === 'ik')) {
          const hasTrackTarget = track.targetEntityId != null;
          const targetId = hasTrackTarget
            ? (typeof track.targetEntityId === 'string' && track.targetEntityId.trim() ? track.targetEntityId : '')
            : (typeof clip.targetEntityId === 'string' && clip.targetEntityId.trim() ? clip.targetEntityId : '');
          const targetPointer = hasTrackTarget ? joinPointer(trackPointer, 'targetEntityId') : joinPointer(pointer, 'targetEntityId');
          const expected = type === 'bone' ? 'Bone' : 'IK';
          if (clipBindings.length) {
            for (const binding of clipBindings) {
              let target = null;
              if (targetId) target = hasTrackTarget
                ? binding.resolveReference(targetId)
                : resolvedClipTargets.get(binding);
              else if (!hasTrackTarget && clip.targetEntityId == null) target = {
                entity: binding.entity,
                id: binding.entityId,
                pointer: binding.pointer
              };
              if (target && !animationRecordHasComponent(target, expected, codec)) output.push(diagnostic(
                type === 'bone' ? 'E_ANIMATION_BONE_TARGET' : 'E_ANIMATION_IK_TARGET',
                `${type === 'bone' ? 'Bone' : 'IK'} track target must have the ${expected} component: ${targetId || binding.entityId}`,
                targetId ? targetPointer : trackPointer,
                {
                  targetEntityId: targetId || binding.entityId,
                  requiredComponent: expected,
                  animationEntityId: binding.entityId,
                  animationPointer: binding.pointer
                }
              ));
            }
          } else if (targetId && knownEntityIds.has(targetId)) {
            if (!animationTargetHasComponent(knownEntityRecords, targetId, expected, codec)) output.push(diagnostic(
              type === 'bone' ? 'E_ANIMATION_BONE_TARGET' : 'E_ANIMATION_IK_TARGET',
              `${type === 'bone' ? 'Bone' : 'IK'} track target must have the ${expected} component: ${targetId}`,
              targetPointer,
              { targetEntityId: targetId, requiredComponent: expected }
            ));
          }
        }
        if (!Array.isArray(track.keyframes)) { output.push(diagnostic('E_ANIMATION_KEYFRAMES', 'Animation track keyframes must be an array', joinPointer(trackPointer, 'keyframes'))); return; }
        const keyIds = new Map();
        const frameKeys = new Map();
        track.keyframes.forEach((keyframe, keyframeIndex) => {
          const keyPointer = joinPointer(joinPointer(trackPointer, 'keyframes'), keyframeIndex);
          if (!isPlainObject(keyframe)) { output.push(diagnostic('E_ANIMATION_KEYFRAME_TYPE', 'Animation keyframe must be a plain object', keyPointer)); return; }
          const keyId = typeof keyframe.id === 'string' ? keyframe.id.trim() : '';
          if (!keyId) animationLegacyDiagnostic(output, strict, 'Legacy Animation keyframe has no stable id', joinPointer(keyPointer, 'id'));
          else if (keyIds.has(keyId)) output.push(diagnostic('E_ANIMATION_KEYFRAME_ID_DUPLICATE', `Duplicate Animation keyframe id: ${keyId}`, joinPointer(keyPointer, 'id'), { firstPointer: keyIds.get(keyId) }));
          else keyIds.set(keyId, joinPointer(keyPointer, 'id'));
          const frameValid = animationInteger(keyframe.frame, strict);
          const frame = Number(keyframe.frame);
          if (!frameValid || frame < 0 || (Number.isInteger(frameCount) && frame >= frameCount)) {
            output.push(diagnostic('E_ANIMATION_KEYFRAME_FRAME', `Keyframe frame must be an integer between 0 and ${Math.max(0, Number(frameCount) - 1)}`, joinPointer(keyPointer, 'frame')));
          } else if (type !== 'event' && frameKeys.has(frame)) {
            output.push(diagnostic('E_ANIMATION_KEYFRAME_FRAME_DUPLICATE', `Track already has a keyframe at frame ${frame}`, joinPointer(keyPointer, 'frame'), { firstPointer: frameKeys.get(frame) }));
          } else frameKeys.set(frame, joinPointer(keyPointer, 'frame'));
          if (keyframe.easing != null && typeof keyframe.easing !== 'string') output.push(diagnostic('E_ANIMATION_EASING', 'Animation keyframe easing must be a string', joinPointer(keyPointer, 'easing')));
          if (!hasOwn(keyframe, 'value')) output.push(diagnostic('E_ANIMATION_KEYFRAME_VALUE', 'Animation keyframe value is required', joinPointer(keyPointer, 'value')));
          else validateAnimationValue(type, keyframe.value, joinPointer(keyPointer, 'value'), output, strict);
        });
      });
    });
    if (!definitionFreeEcsSnapshot) {
      validateAnimationComponentReferences(document, clipIds, clipNames, output, options);
    }
    return output;
  }

  function assertAnimationDocument(document, options = {}) {
    const diagnostics = validateAnimationDocument(document, options);
    const errors = diagnostics.filter(item => item.severity === 'error');
    if (errors.length) {
      const first = errors[0];
      throw new ComponentSchemaError(first.code, first.message, { pointer: first.pointer, details: first.details, diagnostics });
    }
    return diagnostics;
  }

  function skeletonEntityCollections(document) {
    if (!isPlainObject(document)) return [];
    const collections = [];
    if (Array.isArray(document.scenes)) {
      document.scenes.forEach((scene, sceneIndex) => {
        if (Array.isArray(scene?.objects)) collections.push({
          kind: 'scene', id: scene.id, entities: scene.objects,
          pointer: `/scenes/${sceneIndex}/objects`
        });
      });
    } else if (Array.isArray(document.entities)) {
      collections.push({ kind: 'entities', id: null, entities: document.entities, pointer: '/entities' });
    } else if (Array.isArray(document.scene)) {
      collections.push({ kind: 'scene', id: null, entities: document.scene, pointer: '/scene' });
    }
    if (Array.isArray(document.prefabs)) {
      document.prefabs.forEach((prefab, prefabIndex) => {
        if (Array.isArray(prefab?.entities)) collections.push({
          kind: 'prefab', id: prefab.id, entities: prefab.entities,
          pointer: `/prefabs/${prefabIndex}/entities`
        });
      });
    }
    return collections;
  }

  function validateSkeletonDocument(document, options = {}) {
    if (!isPlainObject(document)) return [diagnostic('E_SKELETON_DOCUMENT', 'Skeleton document must be a plain object', '')];
    const output = [];
    const strict = Boolean(options.strict);
    const codec = options.entityCodec instanceof EntityCodec ? options.entityCodec : createDefaultEntityCodec();
    // A lossy ECS snapshot contains expanded runtime Entity IDs but connected
    // Prefab components may intentionally retain their Asset source IDs. The
    // component shapes remain checkable; authoring-scope reference semantics do
    // not. Keep this exemption as narrow as the Animation snapshot boundary.
    const definitionFreeEcsSnapshot = document.format === 'AH2D' && Number(document.version) === 3 &&
      Array.isArray(document.entities) && document.scenes == null && document.prefabs == null;

    for (const scope of skeletonEntityCollections(document)) {
      const byId = new Map();
      const records = [];
      scope.entities.forEach((entity, entityIndex) => {
        if (!isPlainObject(entity)) return;
        const pointer = `${scope.pointer}/${entityIndex}`;
        const id = typeof entity.id === 'string' && entity.id.trim() ? entity.id : '';
        const record = { entity, entityIndex, pointer, id, components: new Map() };
        records.push(record);
        if (!id) return;
        if (!byId.has(id)) byId.set(id, record);
      });

      const component = (record, type) => {
        if (record.components.has(type)) return record.components.get(type);
        let resolved;
        try { resolved = codec.resolve(record.entity, type); }
        catch (_) { resolved = { found: false }; }
        const result = resolved.found
          ? { value: resolved.value, pointer: `${record.pointer}${pointerForStorage(resolved.storage)}`, resolved }
          : null;
        record.components.set(type, result);
        if (result && options.validateComponents !== false) {
          output.push(...codec.registry.validate(type, result.value, {
            pointer: result.pointer,
            profile: definitionFreeEcsSnapshot ? PROFILES.SNAPSHOT : PROFILES.AUTHORING,
            mode: strict ? 'strict' : 'compat',
            strict
          }));
        }
        return result;
      };

      const skeletons = new Map();
      const bones = new Map();
      for (const record of records) {
        const skeleton = component(record, 'Skeleton');
        if (skeleton && isPlainObject(skeleton.value) && record.id) skeletons.set(record.id, { ...record, component: skeleton });
        const bone = component(record, 'Bone');
        if (bone && isPlainObject(bone.value) && record.id) bones.set(record.id, { ...record, component: bone });
        component(record, 'IK');
        component(record, 'Skin');
      }
      if (definitionFreeEcsSnapshot) continue;

      // Connected Prefab instances keep Skeleton-domain references in Asset
      // source-ID space while their concrete Scene Entity IDs are remapped.
      // Resolve marked owners only inside their exact instance group; ordinary
      // unmarked owners continue to use same-collection concrete Entity IDs.
      const markerByRecord = new Map();
      const instanceGroups = new Map();
      for (const record of records) {
        let resolved;
        try { resolved = codec.resolve(record.entity, 'PrefabInstance'); }
        catch (_) { resolved = null; }
        const marker = resolved?.found && isPlainObject(resolved.value) ? resolved.value : null;
        if (!marker || typeof marker.prefabId !== 'string' || typeof marker.instanceRootId !== 'string' ||
            typeof marker.sourceEntityId !== 'string') continue;
        markerByRecord.set(record.pointer, marker);
        const groupKey = `${marker.prefabId}\u0000${marker.instanceRootId}`;
        const group = instanceGroups.get(groupKey) || new Map();
        if (!group.has(marker.sourceEntityId)) group.set(marker.sourceEntityId, record);
        instanceGroups.set(groupKey, group);
      }
      const resolveReference = (owner, authoredId) => {
        const reference = typeof authoredId === 'string' ? authoredId.trim() : '';
        if (!reference) return null;
        const marker = markerByRecord.get(owner.pointer);
        if (marker) {
          const group = instanceGroups.get(`${marker.prefabId}\u0000${marker.instanceRootId}`);
          return group?.get(reference) || null;
        }
        return byId.get(reference) || null;
      };

      const owningSkeleton = boneId => {
        if (skeletons.has(boneId)) return skeletons.get(boneId);
        const seen = new Set();
        let cursor = byId.get(boneId);
        while (cursor && typeof cursor.entity.parentId === 'string' && !seen.has(cursor.id)) {
          seen.add(cursor.id);
          const parentId = cursor.entity.parentId;
          if (skeletons.has(parentId)) return skeletons.get(parentId);
          cursor = byId.get(parentId);
        }
        return null;
      };

      for (const bone of bones.values()) {
        const owner = owningSkeleton(bone.id);
        const parentId = bone.entity.parentId;
        if (!owner) {
          output.push(diagnostic(
            'E_BONE_SKELETON_ANCESTRY',
            `Bone must descend from an Entity with Skeleton: ${bone.id}`,
            joinPointer(bone.pointer, 'parentId'),
            { boneId: bone.id }
          ));
        } else if (bone.id !== owner.id && !bones.has(parentId) && parentId !== owner.id) {
          output.push(diagnostic(
            'E_BONE_PARENT',
            'A Bone parent must be another Bone or its Skeleton root Entity',
            joinPointer(bone.pointer, 'parentId'),
            { boneId: bone.id, parentId }
          ));
        }
      }

      for (const skeleton of skeletons.values()) {
        const rootPointer = joinPointer(skeleton.component.pointer, 'rootBoneId');
        const rootBoneId = typeof skeleton.component.value.rootBoneId === 'string' && skeleton.component.value.rootBoneId.trim()
          ? skeleton.component.value.rootBoneId
          : '';
        const directRootBones = bones.has(skeleton.id)
          ? [bones.get(skeleton.id)]
          : [...bones.values()].filter(bone => bone.entity.parentId === skeleton.id && owningSkeleton(bone.id)?.id === skeleton.id);
        if (rootBoneId) {
          const resolvedRoot = resolveReference(skeleton, rootBoneId);
          const rootBone = resolvedRoot ? bones.get(resolvedRoot.id) : null;
          if (!rootBone) output.push(diagnostic(
            'E_SKELETON_ROOT_BONE_REFERENCE',
            `Skeleton rootBoneId must reference a Bone in the same scope: ${rootBoneId}`,
            rootPointer,
            { skeletonRootId: skeleton.id, rootBoneId }
          ));
          else if (owningSkeleton(rootBone.id)?.id !== skeleton.id || (rootBone.id !== skeleton.id && rootBone.entity.parentId !== skeleton.id)) output.push(diagnostic(
            'E_SKELETON_ROOT_BONE_ANCESTRY',
            'Skeleton rootBoneId must be a direct child of the Skeleton Entity',
            rootPointer,
            { skeletonRootId: skeleton.id, rootBoneId }
          ));
          for (const root of directRootBones) if (root.id !== rootBone?.id) output.push(diagnostic(
            'E_SKELETON_ROOT_BONE_DUPLICATE',
            'A Skeleton may have only one root Bone',
            joinPointer(root.pointer, 'parentId'),
            { skeletonRootId: skeleton.id, rootBoneId, duplicateRootBoneId: root.id }
          ));
        } else if (directRootBones.length > 1) {
          for (const duplicate of directRootBones.slice(1)) output.push(diagnostic(
            'E_SKELETON_ROOT_BONE_DUPLICATE',
            'A Skeleton without rootBoneId may have only one direct root Bone',
            joinPointer(duplicate.pointer, 'parentId'),
            { skeletonRootId: skeleton.id, firstRootBoneId: directRootBones[0].id, duplicateRootBoneId: duplicate.id }
          ));
        }
      }

      for (const record of records) {
        const ik = component(record, 'IK');
        if (ik && isPlainObject(ik.value)) {
          const value = ik.value;
          const skeletonRootId = typeof value.skeletonRootId === 'string' && value.skeletonRootId.trim() ? value.skeletonRootId : '';
          const resolvedSkeleton = resolveReference(record, skeletonRootId);
          const skeleton = resolvedSkeleton ? skeletons.get(resolvedSkeleton.id) : null;
          if (skeletonRootId && !skeleton) output.push(diagnostic(
            'E_IK_SKELETON_REFERENCE',
            `IK skeletonRootId must reference a Skeleton in the same scope: ${skeletonRootId}`,
            joinPointer(ik.pointer, 'skeletonRootId'),
            { skeletonRootId }
          ));
          const seenBones = new Map();
          const resolvedChain = [];
          const chain = Array.isArray(value.bones) ? value.bones : [];
          chain.forEach((boneId, boneIndex) => {
            const bonePointer = joinPointer(joinPointer(ik.pointer, 'bones'), boneIndex);
            if (typeof boneId !== 'string' || !boneId.trim()) return;
            const resolvedBone = resolveReference(record, boneId);
            const resolvedBoneId = resolvedBone?.id || boneId;
            resolvedChain[boneIndex] = resolvedBoneId;
            if (seenBones.has(resolvedBoneId)) output.push(diagnostic(
              'E_IK_BONE_DUPLICATE',
              `IK chain contains duplicate Bone: ${boneId}`,
              bonePointer,
              { boneId, resolvedBoneId, firstPointer: seenBones.get(resolvedBoneId) }
            ));
            else seenBones.set(resolvedBoneId, bonePointer);
            const bone = resolvedBone ? bones.get(resolvedBone.id) : null;
            if (!bone) output.push(diagnostic(
              'E_IK_BONE_REFERENCE',
              `IK chain must reference a Bone in the same scope: ${boneId}`,
              bonePointer,
              { boneId }
            ));
            else if (skeleton && owningSkeleton(bone.id)?.id !== skeleton.id) output.push(diagnostic(
              'E_IK_BONE_ANCESTRY',
              `IK Bone must belong to Skeleton ${skeletonRootId}: ${boneId}`,
              bonePointer,
              { skeletonRootId, boneId }
            ));
            if (boneIndex > 0 && bone && bone.entity.parentId !== resolvedChain[boneIndex - 1]) output.push(diagnostic(
              'E_IK_CHAIN',
              'IK bones must be ordered as a contiguous ancestor-to-descendant chain',
              bonePointer,
              { boneId, expectedParentId: resolvedChain[boneIndex - 1], actualParentId: bone.entity.parentId }
            ));
          });
        }

        const skin = component(record, 'Skin');
        if (!skin || !isPlainObject(skin.value)) continue;
        const value = skin.value;
        const skeletonRootId = typeof value.skeletonRootId === 'string' && value.skeletonRootId.trim() ? value.skeletonRootId : '';
        const resolvedSkeleton = resolveReference(record, skeletonRootId);
        const skeleton = resolvedSkeleton ? skeletons.get(resolvedSkeleton.id) : null;
        if (skeletonRootId && !skeleton) output.push(diagnostic(
          'E_SKIN_SKELETON_REFERENCE',
          `Skin skeletonRootId must reference a Skeleton in the same scope: ${skeletonRootId}`,
          joinPointer(skin.pointer, 'skeletonRootId'),
          { skeletonRootId }
        ));
        const vertices = Array.isArray(value.vertices) ? value.vertices : [];
        if (Array.isArray(value.uvs) && value.uvs.length !== vertices.length * 2) output.push(diagnostic(
          'E_SKIN_UV_COUNT',
          'Skin uvs must contain exactly two values for every vertex',
          joinPointer(skin.pointer, 'uvs'),
          { vertexCount: vertices.length, expected: vertices.length * 2, actual: value.uvs.length }
        ));
        if (Array.isArray(value.indices)) {
          if (value.indices.length % 3 !== 0) output.push(diagnostic(
            'E_SKIN_INDEX_COUNT',
            'Skin indices must contain complete triangles',
            joinPointer(skin.pointer, 'indices'),
            { indexCount: value.indices.length, remainder: value.indices.length % 3 }
          ));
          value.indices.forEach((indexValue, index) => {
            if (!animationInteger(indexValue, strict) || Number(indexValue) < 0 || Number(indexValue) < vertices.length) return;
            output.push(diagnostic(
              'E_SKIN_INDEX_RANGE',
              `Skin index must reference an existing vertex: ${indexValue}`,
              joinPointer(joinPointer(skin.pointer, 'indices'), index),
              { index: Number(indexValue), vertexCount: vertices.length }
            ));
          });
        }
        vertices.forEach((vertex, vertexIndex) => {
          if (!isPlainObject(vertex) || !Array.isArray(vertex.weights)) return;
          const weightsPointer = joinPointer(joinPointer(skin.pointer, 'vertices'), vertexIndex) + '/weights';
          const seenWeights = new Map();
          let total = 0;
          let numericWeights = true;
          vertex.weights.forEach((weight, weightIndex) => {
            if (!isPlainObject(weight)) { numericWeights = false; return; }
            const pointer = joinPointer(weightsPointer, weightIndex);
            const boneId = typeof weight.boneId === 'string' && weight.boneId.trim() ? weight.boneId : '';
            if (animationFiniteNumber(weight.weight, strict)) total += Number(weight.weight);
            else numericWeights = false;
            if (!boneId) return;
            if (seenWeights.has(boneId)) output.push(diagnostic(
              'E_SKIN_BONE_DUPLICATE',
              `Skin vertex contains duplicate Bone weight: ${boneId}`,
              joinPointer(pointer, 'boneId'),
              { boneId, firstPointer: seenWeights.get(boneId) }
            ));
            else seenWeights.set(boneId, joinPointer(pointer, 'boneId'));
            const resolvedBone = resolveReference(record, boneId);
            const bone = resolvedBone ? bones.get(resolvedBone.id) : null;
            if (!bone) output.push(diagnostic(
              'E_SKIN_BONE_REFERENCE',
              `Skin weight must reference a Bone in the same scope: ${boneId}`,
              joinPointer(pointer, 'boneId'),
              { boneId }
            ));
            else if (skeleton && owningSkeleton(bone.id)?.id !== skeleton.id) output.push(diagnostic(
              'E_SKIN_BONE_ANCESTRY',
              `Skin Bone must belong to Skeleton ${skeletonRootId}: ${boneId}`,
              joinPointer(pointer, 'boneId'),
              { skeletonRootId, boneId }
            ));
          });
          if (numericWeights && total <= 0) output.push(diagnostic(
            'E_SKIN_WEIGHT_TOTAL',
            'Skin vertex Bone weights must have a positive total',
            weightsPointer,
            { total }
          ));
        });
      }
    }
    return output;
  }

  function assertSkeletonDocument(document, options = {}) {
    const diagnostics = validateSkeletonDocument(document, options);
    const errors = diagnostics.filter(item => item.severity === 'error');
    if (errors.length) {
      const first = errors[0];
      throw new ComponentSchemaError(first.code, first.message, { pointer: first.pointer, details: first.details, diagnostics });
    }
    return diagnostics;
  }

  function profileName(value) {
    const profile = value || PROFILES.AUTHORING;
    if (!PROFILE_NAMES.includes(profile)) {
      throw new ComponentSchemaError('E_COMPONENT_PROFILE', `Unknown component profile: ${profile}`, { details: { profile, allowed: PROFILE_NAMES } });
    }
    return profile;
  }

  function deletePath(target, path) {
    const parts = Array.isArray(path) ? path : String(path).replace(/^\//, '').split(/[/.]/).filter(Boolean);
    if (!parts.length || !target || typeof target !== 'object') return;
    const [head, ...tail] = parts;
    if (head === '*') {
      for (const key of Object.keys(target)) deletePath(target[key], tail);
      return;
    }
    if (!tail.length) { delete target[head]; return; }
    deletePath(target[head], tail);
  }

  function genericDescriptor(type) {
    const schema = { anyOf: [{ type: 'object' }, { type: 'array' }] };
    const schemas = profileSet(schema);
    return {
      type, aliases: [], schemaVersion: COMPONENT_SCHEMA_VERSION, registered: false,
      required: false, removable: true, tag: false, schema, schemas, profiles: schemas,
      defaults: {}, dynamicDefaults: false, runtimeOnlyFields: [],
      storage: { preferred: `components.${type}`, authoringLocations: [`components.${type}`] }
    };
  }

  class ComponentSchemaRegistry {
    constructor(options = {}) {
      this.openWorld = options.openWorld !== false;
      this._definitions = new Map();
      this._names = new Map();
    }

    register(definition) {
      if (!isPlainObject(definition)) throw new ComponentSchemaError('E_COMPONENT_DEFINITION', 'Component definition must be an object');
      const type = typeof definition.type === 'string' ? definition.type.trim() : '';
      if (!isSafeComponentName(type)) throw new ComponentSchemaError('E_COMPONENT_NAME', `Invalid Component name: ${type || '(empty)'}`);
      const aliases = definition.aliases == null ? [] : definition.aliases;
      if (!Array.isArray(aliases)) throw new ComponentSchemaError('E_COMPONENT_ALIASES', `Aliases for ${type} must be an array`);
      const cleanAliases = aliases.map(alias => typeof alias === 'string' ? alias.trim() : '');
      for (const alias of cleanAliases) {
        if (!isSafeComponentName(alias)) throw new ComponentSchemaError('E_COMPONENT_NAME', `Invalid Component alias: ${alias || '(empty)'}`);
      }
      const schemaVersion = definition.schemaVersion == null ? COMPONENT_SCHEMA_VERSION : definition.schemaVersion;
      if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new ComponentSchemaError('E_COMPONENT_SCHEMA_VERSION', `Invalid schema version for ${type}`);
      const claims = [type, ...cleanAliases];
      const local = new Map();
      for (const name of claims) {
        const folded = name.toLowerCase();
        const previous = local.get(folded);
        const allowedCanonicalCaseAlias = previous === type && name !== type && folded === type.toLowerCase();
        if (previous && !allowedCanonicalCaseAlias) throw new ComponentSchemaError('E_COMPONENT_ALIAS_COLLISION', `Duplicate component name or alias for ${type}: ${name}`);
        local.set(folded, name);
        const owner = this._names.get(folded);
        if (owner && owner !== type) throw new ComponentSchemaError('E_COMPONENT_ALIAS_COLLISION', `Component name or alias ${name} is already owned by ${owner}`, { details: { name, owner, type } });
      }
      if (this._definitions.has(type)) throw new ComponentSchemaError('E_COMPONENT_TYPE_COLLISION', `Component ${type} is already registered`);
      const rawSchemas = definition.schemas || definition.profiles || (definition.schema ? profileSet(definition.schema) : profileSet(object()));
      const schemas = {};
      for (const profile of PROFILE_NAMES) schemas[profile] = cloneJson(rawSchemas[profile] || rawSchemas.authoring || object());
      const migrations = new Map();
      if (definition.migrations != null) {
        const entries = definition.migrations instanceof Map ? [...definition.migrations] : Object.entries(definition.migrations);
        for (const [from, migrate] of entries) {
          const version = Number(from);
          if (!Number.isInteger(version) || version < 1 || version >= schemaVersion || typeof migrate !== 'function') {
            throw new ComponentSchemaError('E_COMPONENT_MIGRATION', `Invalid migration ${from} for ${type}`);
          }
          migrations.set(version, migrate);
        }
      }
      const internal = {
        type, aliases: cleanAliases, schemaVersion, schemas,
        required: Boolean(definition.required), removable: definition.removable !== false && !definition.required,
        tag: Boolean(definition.tag), runtimeOnlyFields: [...(definition.runtimeOnlyFields || [])],
        storage: cloneJson(definition.storage || { preferred: `components.${type}`, authoringLocations: [`components.${type}`] }),
        defaults: definition.defaults == null ? {} : definition.defaults,
        normalizeValue: typeof definition.normalize === 'function' ? definition.normalize : null,
        migrations
      };
      this._definitions.set(type, internal);
      for (const name of claims) this._names.set(name.toLowerCase(), type);
      return this;
    }

    resolve(type) {
      if (typeof type !== 'string') return null;
      const name = type.trim();
      if (!name) return null;
      const known = this._names.get(name.toLowerCase());
      if (known) return known;
      return this.openWorld && isSafeComponentName(name) ? name : null;
    }

    _definition(type) {
      const canonical = this.resolve(type);
      if (!canonical) return null;
      return this._definitions.get(canonical) || null;
    }

    _registeredTypes() {
      return this._definitions.keys();
    }

    _requireType(type) {
      const canonical = this.resolve(type);
      if (!canonical) throw new ComponentSchemaError('E_COMPONENT_NAME', `Invalid or unknown Component name: ${type || '(empty)'}`);
      return canonical;
    }

    describe(type) {
      const canonical = this.resolve(type);
      if (!canonical) return null;
      const definition = this._definitions.get(canonical);
      if (!definition) return cloneJson(genericDescriptor(canonical));
      const context = { profile: PROFILES.AUTHORING };
      const defaults = typeof definition.defaults === 'function' ? definition.defaults(context) : definition.defaults;
      return cloneJson({
        type: definition.type, aliases: definition.aliases, schemaVersion: definition.schemaVersion, registered: true,
        required: definition.required, removable: definition.removable, tag: definition.tag,
        schema: definition.schemas.authoring, schemas: definition.schemas, profiles: definition.schemas,
        defaults: defaults || {}, dynamicDefaults: typeof definition.defaults === 'function',
        runtimeOnlyFields: definition.runtimeOnlyFields, storage: definition.storage
      });
    }

    list() {
      return [...this._definitions.keys()].map(type => this.describe(type));
    }

    create(type, overrides = {}, context = {}) {
      const canonical = this._requireType(type);
      const definition = this._definitions.get(canonical);
      const defaults = definition
        ? (typeof definition.defaults === 'function' ? definition.defaults({ ...context, profile: profileName(context.profile) }) : definition.defaults)
        : {};
      const source = overrides === undefined ? {} : overrides;
      const value = isPlainObject(defaults) && isPlainObject(source) ? deepMerge(defaults, source) : cloneJson(source);
      return this.assert(canonical, value, { ...context, [NORMALIZATION_SOURCE]: source, applyDefaults: false });
    }

    normalize(type, value, options = {}) {
      const canonical = this._requireType(type);
      const profile = profileName(options.profile);
      const safety = jsonSafetyDiagnostics(value, options.pointer || '');
      if (safety.length) throw new ComponentSchemaError(safety[0].code, safety[0].message, { pointer: safety[0].pointer, diagnostics: safety });
      const definition = this._definitions.get(canonical);
      let normalized = cloneJson(value);
      if (definition && options.applyDefaults) {
        const defaults = typeof definition.defaults === 'function' ? definition.defaults({ ...options, profile }) : definition.defaults;
        if (isPlainObject(defaults) && isPlainObject(normalized)) normalized = deepMerge(defaults, normalized);
      }
      if (definition && definition.normalizeValue) normalized = definition.normalizeValue(normalized, {
        ...options,
        type: canonical,
        profile,
        sourceValue: hasOwn(options, NORMALIZATION_SOURCE) ? options[NORMALIZATION_SOURCE] : value
      });
      if (profile === PROFILES.AUTHORING && options.filterRuntimeOnly !== false && definition) {
        for (const path of definition.runtimeOnlyFields) deletePath(normalized, path);
      }
      const normalizedSafety = jsonSafetyDiagnostics(normalized, options.pointer || '');
      if (normalizedSafety.length) {
        throw new ComponentSchemaError(normalizedSafety[0].code, normalizedSafety[0].message, {
          pointer: normalizedSafety[0].pointer,
          diagnostics: normalizedSafety
        });
      }
      return normalized;
    }

    validate(type, value, options = {}) {
      const canonical = this.resolve(type);
      const pointer = options.pointer || '';
      if (!canonical) return [diagnostic('E_COMPONENT_NAME', `Invalid or unknown Component name: ${type || '(empty)'}`, pointer)];
      const safety = jsonSafetyDiagnostics(value, pointer);
      if (safety.length) return safety;
      if (!isPlainObject(value) && !Array.isArray(value)) {
        return [diagnostic('E_COMPONENT_VALUE', 'Component value must be an object or array', pointer)];
      }
      const definition = this._definitions.get(canonical);
      const schema = definition ? definition.schemas[profileName(options.profile)] : genericDescriptor(canonical).schemas[profileName(options.profile)];
      const diagnostics = validateSchema(value, schema, pointer, [], options);
      if (definition && COLLIDER_COMPONENT_TYPE_SET.has(definition.type)) diagnostics.push(...colliderIdDiagnostics(value, pointer));
      return diagnostics;
    }

    assert(type, value, options = {}) {
      const canonical = this._requireType(type);
      const normalized = options.normalize === false ? cloneJson(value) : this.normalize(canonical, value, options);
      const diagnostics = this.validate(canonical, normalized, options);
      if (diagnostics.some(item => item.severity === 'error')) {
        const first = diagnostics.find(item => item.severity === 'error');
        throw new ComponentSchemaError(first.code, first.message, { pointer: first.pointer, diagnostics, details: first.details });
      }
      return normalized;
    }

    migrate(type, value, fromVersion, options = {}) {
      if (isPlainObject(fromVersion)) { options = fromVersion; fromVersion = options.fromVersion; }
      const canonical = this._requireType(type);
      const definition = this._definitions.get(canonical);
      const targetVersion = options.toVersion == null ? (definition ? definition.schemaVersion : COMPONENT_SCHEMA_VERSION) : Number(options.toVersion);
      let version = fromVersion == null ? Number(options.fromVersion || COMPONENT_SCHEMA_VERSION) : Number(fromVersion);
      if (!Number.isInteger(version) || version < 1 || !Number.isInteger(targetVersion) || targetVersion < 1 || version > targetVersion) {
        throw new ComponentSchemaError('E_COMPONENT_MIGRATION_VERSION', `Cannot migrate ${canonical} from version ${version} to ${targetVersion}`);
      }
      let migrated = cloneJson(value);
      while (version < targetVersion) {
        const migrate = definition && definition.migrations.get(version);
        if (!migrate) throw new ComponentSchemaError('E_COMPONENT_MIGRATION_MISSING', `Missing ${canonical} migration from version ${version}`, { details: { type: canonical, fromVersion: version, toVersion: version + 1 } });
        const next = migrate(cloneJson(migrated), { ...options, type: canonical, fromVersion: version, toVersion: version + 1, registry: this });
        if (next !== undefined) migrated = next;
        version += 1;
      }
      return this.assert(canonical, migrated, { ...options, applyDefaults: false });
    }
  }

  const finiteOr = (value, fallback) => value == null ? fallback : (Number.isFinite(Number(value)) ? Number(value) : value);

  function transformDefaults(context = {}) {
    const entity = context.entity || {};
    return {
      x: finiteOr(entity.x, 0), y: finiteOr(entity.y, 0),
      rotation: finiteOr(entity.rotation == null ? entity.rot : entity.rotation, 0),
      scaleX: finiteOr(entity.scaleX == null ? entity.sx : entity.scaleX, 1),
      scaleY: finiteOr(entity.scaleY == null ? entity.sy : entity.scaleY, 1),
      ...(context.profile === PROFILES.RUNTIME || context.profile === PROFILES.SNAPSHOT ? { world: [1, 0, 0, 1, 0, 0] } : {})
    };
  }

  function colliderDimensions(entity = {}) {
    const rawWidth = Number(entity.w == null ? entity.width : entity.w);
    const rawHeight = Number(entity.h == null ? entity.height : entity.h);
    const width = Math.max(1, Math.abs(Number.isFinite(rawWidth) && rawWidth !== 0 ? rawWidth : 64));
    const height = Math.max(1, Math.abs(Number.isFinite(rawHeight) && rawHeight !== 0 ? rawHeight : 64));
    return { width, height };
  }

  function colliderDefaults(context = {}, shape = 'rectangle') {
    const { width, height } = colliderDimensions(context.entity);
    return {
      enabled: true, shape, width, height, radius: Math.max(1, Math.min(width, height) / 2),
      offsetX: 0, offsetY: 0, rotation: 0, density: 1, friction: 0.35, restitution: 0.05,
      isTrigger: false, categoryBits: 1, maskBits: 65535, groupIndex: 0
    };
  }

  const RIGIDBODY_DEFAULTS = {
    enabled: true, type: 'dynamic', mass: 1, useAutoMass: false, gravityScale: 1,
    linearDamping: 0.08, angularDamping: 0.08, fixedRotation: false, bullet: false,
    allowSleep: true, sleeping: false, velocityX: 0, velocityY: 0, angularVelocity: 0
  };

  function normalizeTransform(value, context = {}) {
    if (!isPlainObject(value)) return value;
    const output = cloneJson(value);
    const source = isPlainObject(context.sourceValue) ? context.sourceValue : value;
    if (!hasOwn(source, 'rotation') && hasOwn(source, 'rot')) output.rotation = source.rot;
    else if (!hasOwn(output, 'rotation') && hasOwn(output, 'rot')) output.rotation = output.rot;
    if (!hasOwn(source, 'scaleX') && hasOwn(source, 'sx')) output.scaleX = source.sx;
    else if (!hasOwn(output, 'scaleX') && hasOwn(output, 'sx')) output.scaleX = output.sx;
    if (!hasOwn(source, 'scaleY') && hasOwn(source, 'sy')) output.scaleY = source.sy;
    else if (!hasOwn(output, 'scaleY') && hasOwn(output, 'sy')) output.scaleY = output.sy;
    return output;
  }

  function normalizeCollider(value, context) {
    if (Array.isArray(value)) return value.map(item => normalizeCollider(item, context));
    if (!isPlainObject(value)) return value;
    const output = cloneJson(value);
    if (context.profile === PROFILES.RUNTIME || context.profile === PROFILES.SNAPSHOT) {
      if (output.shape === 'rectangle') output.shape = 'box';
      if (Array.isArray(output.colliders)) output.colliders = output.colliders.map(item => normalizeCollider(item, context));
      if (Array.isArray(output.shapes)) output.shapes = output.shapes.map(item => normalizeCollider(item, context));
    }
    return output;
  }

  const BUILTIN_DEFINITIONS = [
    { type: 'Name', required: true, removable: false, schemas: COMPONENT_SCHEMAS.Name, defaults: context => ({ value: String(context.entity && context.entity.name != null ? context.entity.name : 'Game Object') }), storage: { preferred: 'flat-name', authoringLocations: ['components.Name', 'flat-name'] } },
    { type: 'Transform', required: true, removable: false, schemas: COMPONENT_SCHEMAS.Transform, defaults: transformDefaults, normalize: normalizeTransform, runtimeOnlyFields: ['world'], storage: { preferred: 'flat-transform', authoringLocations: ['components.Transform', 'transform', 'flat-transform'] } },
    { type: 'Renderable', schemas: COMPONENT_SCHEMAS.Renderable, defaults: {}, storage: { preferred: 'components.Renderable', authoringLocations: ['components.Renderable', 'flat-renderable'] } },
    { type: 'Rigidbody', aliases: ['RigidBody', 'Body'], schemas: COMPONENT_SCHEMAS.Rigidbody, defaults: RIGIDBODY_DEFAULTS, runtimeOnlyFields: ['inverseMass', 'inertia', 'inverseInertia', 'force', 'torque', 'sleepTime', '_lastVelocityWritten', '_lastAngularVelocityWritten', '_lastSleepingWritten'], storage: { preferred: 'rigidbody', authoringLocations: ['components.Rigidbody', 'components.RigidBody', 'components.Body', 'rigidbody', 'rigidBody'] } },
    { type: 'Collider', schemas: COMPONENT_SCHEMAS.Collider, defaults: context => colliderDefaults(context, 'rectangle'), normalize: normalizeCollider, runtimeOnlyFields: ['source', '*.source', 'colliders.*.source', 'shapes.*.source'], storage: { preferred: 'collider', authoringLocations: ['components.Collider', 'collider'] } },
    { type: 'Hidden', schemas: COMPONENT_SCHEMAS.Hidden, defaults: {}, tag: true, storage: { preferred: 'flat-hidden', authoringLocations: ['components.Hidden', 'flat-hidden'] } },
    { type: 'Locked', schemas: COMPONENT_SCHEMAS.Locked, defaults: {}, tag: true, storage: { preferred: 'flat-locked', authoringLocations: ['components.Locked', 'flat-locked'] } },
    { type: 'PrefabInstance', schemas: COMPONENT_SCHEMAS.PrefabInstance, defaults: {}, storage: { preferred: 'components.PrefabInstance', authoringLocations: ['components.PrefabInstance', 'flat-prefab'] } },
    { type: 'Camera', schemas: COMPONENT_SCHEMAS.Camera, defaults: {} },
    { type: 'Light', schemas: COMPONENT_SCHEMAS.Light, defaults: {} },
    { type: 'ShadowCaster', schemas: COMPONENT_SCHEMAS.ShadowCaster, defaults: {} },
    { type: 'Animation', schemas: COMPONENT_SCHEMAS.Animation, defaults: {}, runtimeOnlyFields: ['frame', 'sampledHitboxes', 'completed'] },
    { type: 'Skeleton', schemas: COMPONENT_SCHEMAS.Skeleton, defaults: { enabled: true, solveIK: true, debug: false }, runtimeOnlyFields: ['pose', 'boneMatrices'] },
    { type: 'Bone', schemas: COMPONENT_SCHEMAS.Bone, defaults: { length: 32, inheritRotation: true, inheritScale: true } },
    { type: 'IK', schemas: COMPONENT_SCHEMAS.IK, defaults: {} },
    { type: 'Skin', schemas: COMPONENT_SCHEMAS.Skin, defaults: {}, runtimeOnlyFields: ['deformedVertices'] },
    { type: 'Tilemap', schemas: COMPONENT_SCHEMAS.Tilemap, defaults: {} },
    { type: 'ParticleEmitter', schemas: COMPONENT_SCHEMAS.ParticleEmitter, defaults: {} },
    { type: 'BoxCollider', schemas: COMPONENT_SCHEMAS.BoxCollider, defaults: context => colliderDefaults(context, 'box'), normalize: normalizeCollider, runtimeOnlyFields: ['source', '*.source', 'colliders.*.source', 'shapes.*.source'] },
    { type: 'BoxCollider2D', schemas: COMPONENT_SCHEMAS.BoxCollider2D, defaults: context => colliderDefaults(context, 'box'), normalize: normalizeCollider, runtimeOnlyFields: ['source', '*.source', 'colliders.*.source', 'shapes.*.source'] },
    { type: 'CircleCollider', schemas: COMPONENT_SCHEMAS.CircleCollider, defaults: context => colliderDefaults(context, 'circle'), normalize: normalizeCollider, runtimeOnlyFields: ['source', '*.source', 'colliders.*.source', 'shapes.*.source'] },
    { type: 'CircleCollider2D', schemas: COMPONENT_SCHEMAS.CircleCollider2D, defaults: context => colliderDefaults(context, 'circle'), normalize: normalizeCollider, runtimeOnlyFields: ['source', '*.source', 'colliders.*.source', 'shapes.*.source'] }
  ];

  function createDefaultComponentRegistry(options = {}) {
    const registry = new ComponentSchemaRegistry(options);
    for (const definition of BUILTIN_DEFINITIONS) registry.register(definition);
    return registry;
  }

  function pointerForStorage(storage) {
    if (!storage) return '';
    if (storage.startsWith('components.')) return `/components/${escapePointer(storage.slice('components.'.length))}`;
    if (storage === 'flat-name') return '/name';
    if (storage === 'flat-transform' || storage === 'flat-renderable') return '';
    if (storage === 'flat-hidden') return '/visible';
    if (storage === 'flat-locked') return '/locked';
    if (storage === 'flat-prefab') return '/prefab';
    return `/${escapePointer(storage)}`;
  }

  class EntityCodec {
    constructor(registry = createDefaultComponentRegistry(), options = {}) {
      if (!(registry instanceof ComponentSchemaRegistry)) throw new ComponentSchemaError('E_COMPONENT_REGISTRY', 'EntityCodec requires a ComponentSchemaRegistry');
      this.registry = registry;
      this.options = { ...options };
    }

    _componentCandidates(entity, canonical) {
      if (!isPlainObject(entity.components)) return [];
      const keys = Object.keys(entity.components);
      const matching = keys.filter(key => this.registry.resolve(key) === canonical);
      matching.sort((left, right) => {
        if (left === canonical) return -1;
        if (right === canonical) return 1;
        const aliases = this.registry._definition(canonical)?.aliases || [];
        const leftIndex = aliases.findIndex(alias => alias.toLowerCase() === left.toLowerCase());
        const rightIndex = aliases.findIndex(alias => alias.toLowerCase() === right.toLowerCase());
        return (leftIndex < 0 ? aliases.length : leftIndex) - (rightIndex < 0 ? aliases.length : rightIndex);
      });
      return matching.map(key => ({ type: canonical, key, storage: `components.${key}`, provenance: `components.${key}`, value: entity.components[key], rawValue: entity.components[key], explicit: true }));
    }

    _flatTransform(entity) {
      const mapping = [
        ['x', ['x']], ['y', ['y']], ['rotation', ['rotation', 'rot']], ['scaleX', ['scaleX', 'sx']], ['scaleY', ['scaleY', 'sy']]
      ];
      const value = {};
      let explicit = false;
      for (const [target, sources] of mapping) {
        const source = sources.find(key => hasOwn(entity, key));
        if (source) { value[target] = entity[source]; explicit = true; }
      }
      return { value, explicit };
    }

    _flatRenderable(entity) {
      const fields = { kind: 'kind', width: hasOwn(entity, 'width') ? 'width' : 'w', height: hasOwn(entity, 'height') ? 'height' : 'h', color: 'color', imageSrc: 'imageSrc', layer: 'layer' };
      const value = {};
      let explicit = false;
      for (const [target, source] of Object.entries(fields)) {
        if (hasOwn(entity, source) && entity[source] !== undefined) { value[target] = entity[source]; explicit = true; }
      }
      // assetId is shared by the legacy Renderable and PrefabInstance projections.
      // A prefab-only asset must not manufacture a Renderable candidate, while an
      // otherwise explicit Renderable may still use the same authored field.
      const prefabOwnsAsset = entity.prefab === true || this._componentCandidates(entity, 'PrefabInstance').length > 0;
      if (hasOwn(entity, 'assetId') && entity.assetId !== undefined && (!prefabOwnsAsset || explicit)) {
        value.assetId = entity.assetId;
        explicit = true;
      }
      return { value, explicit };
    }

    _legacyCandidates(entity, canonical) {
      const candidates = [];
      const add = (storage, value, explicit = true) => candidates.push({ type: canonical, key: storage, storage, provenance: storage, value, rawValue: value, explicit });
      if (canonical === 'Name') {
        if (hasOwn(entity, 'name')) add('flat-name', { value: entity.name });
        else add('flat-name', { value: 'Game Object' }, false);
      } else if (canonical === 'Transform') {
        if (hasOwn(entity, 'transform')) add('transform', entity.transform);
        const flat = this._flatTransform(entity);
        add('flat-transform', flat.value, flat.explicit);
      } else if (canonical === 'Renderable') {
        const flat = this._flatRenderable(entity);
        if (flat.explicit) add('flat-renderable', flat.value);
      } else if (canonical === 'Rigidbody') {
        if (hasOwn(entity, 'rigidbody')) add('rigidbody', entity.rigidbody);
        if (hasOwn(entity, 'rigidBody')) add('rigidBody', entity.rigidBody);
      } else if (canonical === 'Collider') {
        if (hasOwn(entity, 'collider')) add('collider', entity.collider);
      } else if (canonical === 'Hidden' && entity.visible === false) add('flat-hidden', {});
      else if (canonical === 'Locked' && entity.locked === true) add('flat-locked', {});
      else if (canonical === 'PrefabInstance' && entity.prefab === true) add('flat-prefab', { assetId: entity.assetId == null ? null : entity.assetId });
      return candidates;
    }

    _transformValue(entity, candidates) {
      // Resolution must remain diagnostic-only for malformed authored values;
      // validation, rather than default creation, reports their exact pointers.
      let value = transformDefaults({ entity, profile: PROFILES.AUTHORING });
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const source = candidates[index].value;
        if (!isPlainObject(source)) { if (index === 0) return source; continue; }
        const normalized = normalizeTransform(source);
        value = { ...value, ...normalized };
        if (hasOwn(normalized, 'x')) value.x = normalized.x;
        if (hasOwn(normalized, 'y')) value.y = normalized.y;
        if (hasOwn(normalized, 'rotation')) value.rotation = normalized.rotation;
        if (hasOwn(normalized, 'scaleX')) value.scaleX = normalized.scaleX;
        if (hasOwn(normalized, 'scaleY')) value.scaleY = normalized.scaleY;
      }
      return value;
    }

    _candidatesConflict(canonical, left, right) {
      if (canonical !== 'Transform' || !isPlainObject(left) || !isPlainObject(right)) return !sameValue(left, right);
      const comparable = value => {
        const output = normalizeTransform(value);
        delete output.rot;
        delete output.sx;
        delete output.sy;
        return output;
      };
      const leftValue = comparable(left);
      const rightValue = comparable(right);
      return Object.keys(leftValue).some(key => hasOwn(rightValue, key) && !sameValue(leftValue[key], rightValue[key]));
    }

    resolve(entity, type, options = {}) {
      if (!isPlainObject(entity)) throw new ComponentSchemaError('E_ENTITY_VALUE', 'Entity must be a plain object');
      const canonical = this.registry._requireType(type);
      const componentCandidates = this._componentCandidates(entity, canonical);
      const legacyCandidates = this._legacyCandidates(entity, canonical);
      const candidates = [...componentCandidates, ...legacyCandidates];
      const metadata = this.registry._definition(canonical);
      const found = candidates.length > 0 || Boolean(metadata && metadata.required);
      if (!found) return { found: false, type: canonical, value: undefined, storage: null, provenance: null, conflicts: [], candidates: [] };
      const preferredStorage = metadata?.storage?.preferred || `components.${canonical}`;
      const selected = candidates[0] || { storage: preferredStorage, provenance: preferredStorage, value: this.registry.create(canonical, {}, { entity }) };
      const effectiveValue = canonical === 'Transform' ? this._transformValue(entity, candidates) : selected.value;
      const conflicts = candidates.slice(1).filter(candidate => candidate.explicit && selected.explicit !== false && this._candidatesConflict(canonical, selected.rawValue, candidate.rawValue)).map(candidate => ({
        type: canonical, storage: candidate.storage, provenance: candidate.provenance, value: candidate.value,
        selectedStorage: selected.storage, selectedProvenance: selected.provenance
      }));
      return {
        found: true, type: canonical, value: options.clone ? cloneJson(effectiveValue) : effectiveValue,
        storage: selected.storage, provenance: selected.provenance, conflicts,
        candidates: candidates.map(candidate => ({ storage: candidate.storage, provenance: candidate.provenance, value: options.clone ? cloneJson(candidate.value) : candidate.value, explicit: candidate.explicit }))
      };
    }

    list(entity, options = {}) {
      if (!isPlainObject(entity)) throw new ComponentSchemaError('E_ENTITY_VALUE', 'Entity must be a plain object');
      const output = [];
      const included = new Set();
      for (const type of this.registry._registeredTypes()) {
        const resolved = this.resolve(entity, type, options);
        if (resolved.found) {
          output.push({ type: resolved.type, value: resolved.value, storage: resolved.storage, provenance: resolved.provenance, conflicts: resolved.conflicts });
          included.add(resolved.type);
        }
      }
      if (isPlainObject(entity.components)) {
        for (const key of Object.keys(entity.components)) {
          const canonical = this.registry.resolve(key);
          if (!canonical || included.has(canonical)) continue;
          output.push({ type: canonical, value: options.clone ? cloneJson(entity.components[key]) : entity.components[key], storage: `components.${key}`, provenance: `components.${key}`, conflicts: [] });
          included.add(canonical);
        }
      }
      return output;
    }

    validate(entity, options = {}) {
      const diagnostics = [];
      const base = options.pointer || '';
      if (!isPlainObject(entity)) return [diagnostic('E_ENTITY_VALUE', 'Entity must be a plain object', base)];
      diagnostics.push(...jsonSafetyDiagnostics(entity, base));
      if (diagnostics.length) return diagnostics;
      if (!hasOwn(entity, 'id') || typeof entity.id !== 'string' || !entity.id.trim()) diagnostics.push(diagnostic('E_ENTITY_ID', 'Entity id must be a non-empty string', joinPointer(base, 'id')));
      if (hasOwn(entity, 'parentId') && entity.parentId !== null && typeof entity.parentId !== 'string') diagnostics.push(diagnostic('E_ENTITY_PARENT', 'Entity parentId must be a string or null', joinPointer(base, 'parentId')));
      if (hasOwn(entity, 'components') && !isPlainObject(entity.components)) diagnostics.push(diagnostic('E_COMPONENT_MAP', 'Entity components must be an object', joinPointer(base, 'components')));
      if (isPlainObject(entity.components)) {
        for (const [key, value] of Object.entries(entity.components)) {
          const pointer = joinPointer(joinPointer(base, 'components'), key);
          if (!isSafeComponentName(key)) diagnostics.push(diagnostic('E_COMPONENT_NAME', `Component keys must be safe PascalCase names: ${key}`, pointer));
          diagnostics.push(...this.registry.validate(key, value, { ...options, pointer }));
        }
      }
      for (const type of this.registry._registeredTypes()) {
        const candidates = [...this._componentCandidates(entity, type), ...this._legacyCandidates(entity, type)];
        for (const candidate of candidates) {
          if (!candidate.explicit || candidate.storage.startsWith('components.')) continue;
          const candidateDiagnostics = this.registry.validate(type, candidate.rawValue, { ...options, pointer: '' });
          diagnostics.push(...candidateDiagnostics.map(item => ({
            ...item,
            pointer: this._legacyDiagnosticPointer(entity, candidate, item.pointer, base)
          })));
        }
        const resolved = this.resolve(entity, type);
        for (const conflict of resolved.conflicts) {
          diagnostics.push(diagnostic('E_COMPONENT_CONFLICT', `${type} has conflicting values at ${resolved.storage} and ${conflict.storage}`, `${base}${pointerForStorage(resolved.storage)}`, { type, selected: resolved.storage, conflicting: conflict.storage }, options.strict ? 'error' : 'warning'));
        }
      }
      const colliderIds = new Map();
      for (const type of COLLIDER_COMPONENT_TYPES) {
        if (!this.registry._definition(type)) continue;
        const resolved = this.resolve(entity, type);
        if (!resolved.found) continue;
        const componentPointer = `${base}${pointerForStorage(resolved.storage)}`;
        for (const fixture of colliderFixtureEntries(resolved.value, componentPointer)) {
          const id = fixture.value.id;
          if (typeof id !== 'string' || !id) continue;
          const idPointer = joinPointer(fixture.pointer, 'id');
          const first = colliderIds.get(id);
          // Component validation already reports duplicates inside one Collider
          // value. This entity-level pass covers ids reused by another Collider
          // component type, matching the shared runtime fixture namespace.
          if (first && first.type !== type) {
            diagnostics.push(diagnostic(
              'E_COLLIDER_ID_DUPLICATE',
              `Duplicate Collider id within Entity: ${id}`,
              idPointer,
              { entityId: entity.id, colliderId: id, component: type, firstComponent: first.type, firstPointer: first.pointer }
            ));
          } else if (!first) colliderIds.set(id, { type, pointer: idPointer });
        }
      }
      return diagnostics;
    }

    _preferredStorage(type) {
      const descriptor = this.registry.describe(type);
      return descriptor && descriptor.storage && descriptor.storage.preferred ? descriptor.storage.preferred : `components.${type}`;
    }

    _storageMatches(type, storage) {
      if (typeof storage !== 'string' || !storage) return false;
      if (storage.startsWith('components.')) {
        const key = storage.slice('components.'.length);
        return isSafeComponentName(key) && this.registry.resolve(key) === type;
      }
      const descriptor = this.registry.describe(type);
      const locations = descriptor && descriptor.storage && descriptor.storage.authoringLocations;
      return Array.isArray(locations) && locations.includes(storage);
    }

    _legacyDiagnosticPointer(entity, candidate, localPointer, base) {
      const parts = String(localPointer || '').replace(/^\//, '').split('/').filter(Boolean);
      const first = parts.shift();
      if (candidate.storage === 'flat-name') return joinPointer(base, 'name');
      if (candidate.storage === 'flat-transform') {
        const aliases = {
          x: 'x', y: 'y',
          rotation: hasOwn(entity, 'rotation') ? 'rotation' : 'rot',
          scaleX: hasOwn(entity, 'scaleX') ? 'scaleX' : 'sx',
          scaleY: hasOwn(entity, 'scaleY') ? 'scaleY' : 'sy'
        };
        let pointer = first ? joinPointer(base, aliases[first] || first) : base;
        for (const part of parts) pointer = joinPointer(pointer, part);
        return pointer;
      }
      if (candidate.storage === 'transform') {
        const source = isPlainObject(candidate.rawValue) ? candidate.rawValue : {};
        const aliases = {
          rotation: hasOwn(source, 'rotation') ? 'rotation' : (hasOwn(source, 'rot') ? 'rot' : 'rotation'),
          scaleX: hasOwn(source, 'scaleX') ? 'scaleX' : (hasOwn(source, 'sx') ? 'sx' : 'scaleX'),
          scaleY: hasOwn(source, 'scaleY') ? 'scaleY' : (hasOwn(source, 'sy') ? 'sy' : 'scaleY')
        };
        let pointer = joinPointer(base, 'transform');
        if (first) pointer = joinPointer(pointer, aliases[first] || first);
        for (const part of parts) pointer = joinPointer(pointer, part);
        return pointer;
      }
      if (candidate.storage === 'flat-renderable') {
        const aliases = {
          width: hasOwn(entity, 'width') ? 'width' : 'w',
          height: hasOwn(entity, 'height') ? 'height' : 'h'
        };
        let pointer = first ? joinPointer(base, aliases[first] || first) : base;
        for (const part of parts) pointer = joinPointer(pointer, part);
        return pointer;
      }
      if (candidate.storage === 'flat-prefab') {
        if (first === 'assetId') return joinPointer(base, 'assetId');
        return joinPointer(base, 'prefab');
      }
      let pointer = `${base}${pointerForStorage(candidate.storage)}`;
      if (first) pointer = joinPointer(pointer, first);
      for (const part of parts) pointer = joinPointer(pointer, part);
      return pointer;
    }

    _compactStorageCanRepresent(storage, value, entity = {}) {
      if (!isPlainObject(value)) return false;
      const keys = Object.keys(value);
      if (storage === 'flat-name') return keys.every(key => key === 'value');
      if (storage === 'flat-transform') {
        const allowed = new Set(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'rot', 'sx', 'sy']);
        if (!keys.every(key => allowed.has(key))) return false;
        if (hasOwn(value, 'rotation') && hasOwn(value, 'rot') && !sameValue(value.rotation, value.rot)) return false;
        if (hasOwn(value, 'scaleX') && hasOwn(value, 'sx') && !sameValue(value.scaleX, value.sx)) return false;
        if (hasOwn(value, 'scaleY') && hasOwn(value, 'sy') && !sameValue(value.scaleY, value.sy)) return false;
        return true;
      }
      if (storage === 'flat-renderable') {
        const allowed = new Set(['kind', 'width', 'height', 'color', 'assetId', 'imageSrc', 'layer']);
        if (!keys.every(key => allowed.has(key))) return false;
        if (entity.prefab === true && hasOwn(value, 'assetId') && !sameValue(value.assetId, entity.assetId == null ? null : entity.assetId)) return false;
        return true;
      }
      if (storage === 'flat-hidden' || storage === 'flat-locked') return keys.length === 0;
      if (storage === 'flat-prefab') {
        if (keys.length !== 1 || keys[0] !== 'assetId') return false;
        const renderable = this._flatRenderable(entity);
        const sharedWithRenderable = Object.keys(renderable.value).some(key => key !== 'assetId');
        return !sharedWithRenderable || sameValue(value.assetId, entity.assetId == null ? null : entity.assetId);
      }
      return true;
    }

    _writePointerBase(storage, pointer) {
      const value = pointer || '';
      const suffixes = {
        'flat-name': '/name',
        'flat-hidden': '/visible',
        'flat-locked': '/locked',
        'flat-prefab': '/prefab'
      };
      const suffix = suffixes[storage] || '';
      return suffix && value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
    }

    write(entity, type, value, options = {}) {
      if (!isPlainObject(entity)) throw new ComponentSchemaError('E_ENTITY_VALUE', 'Entity must be a plain object');
      const canonical = this.registry._requireType(type);
      const requestedStorage = options.storage || 'preserve';
      const current = this.resolve(entity, canonical);
      let storage;
      if (requestedStorage === 'preserve') storage = options.provenance || (current.found ? current.storage : this._preferredStorage(canonical));
      else if (requestedStorage === 'canonical' || requestedStorage === 'components') storage = `components.${canonical}`;
      else if (requestedStorage === 'authoring' || requestedStorage === 'legacy') storage = this._preferredStorage(canonical);
      else storage = requestedStorage;
      if (typeof storage !== 'string' || !storage) throw new ComponentSchemaError('E_COMPONENT_STORAGE', `Invalid storage for ${canonical}`);
      if (!this._storageMatches(canonical, storage)) {
        throw new ComponentSchemaError('E_COMPONENT_STORAGE', `Storage ${storage} does not match ${canonical}`, { details: { type: canonical, storage } });
      }
      const remapFlatPointer = ['flat-name', 'flat-transform', 'flat-renderable', 'flat-prefab'].includes(storage);
      const writePointerBase = this._writePointerBase(storage, options.pointer || '');
      const validationPointer = remapFlatPointer ? '' : (options.pointer || '');
      let source;
      let normalized;
      try {
        source = value === undefined
          ? this.registry.create(canonical, {}, { ...options, entity, profile: options.profile || PROFILES.AUTHORING, pointer: validationPointer })
          : value;
        normalized = this.registry.assert(canonical, source, {
          ...options,
          profile: options.profile || PROFILES.AUTHORING,
          pointer: validationPointer
        });
      } catch (error) {
        if (!(error instanceof ComponentSchemaError) || !remapFlatPointer || !error.diagnostics.length) throw error;
        const candidate = { storage, rawValue: source === undefined ? current.value : source };
        const diagnostics = error.diagnostics.map(item => ({
          ...item,
          pointer: this._legacyDiagnosticPointer(entity, candidate, item.pointer, writePointerBase)
        }));
        const first = diagnostics.find(item => item.severity === 'error') || diagnostics[0];
        throw new ComponentSchemaError(first.code, first.message, { pointer: first.pointer, diagnostics, details: first.details });
      }
      const promoteToCanonical = storage.startsWith('flat-') && !this._compactStorageCanRepresent(storage, normalized, entity);
      if (promoteToCanonical && entity.components != null && !isPlainObject(entity.components)) {
        const pointer = joinPointer(writePointerBase, 'components');
        throw new ComponentSchemaError('E_COMPONENT_MAP', 'Entity components must be an object', {
          pointer,
          diagnostics: [diagnostic('E_COMPONENT_MAP', 'Entity components must be an object', pointer)]
        });
      }
      if (promoteToCanonical) {
        this._removeStorage(entity, storage, { preservePrefabAsset: true });
        storage = `components.${canonical}`;
      }
      const stored = cloneJson(normalized);
      if (storage.startsWith('components.')) {
        const key = storage.slice('components.'.length);
        if (!isSafeComponentName(key) || this.registry.resolve(key) !== canonical) throw new ComponentSchemaError('E_COMPONENT_STORAGE', `Storage ${storage} does not match ${canonical}`);
        if (entity.components == null) entity.components = {};
        if (!isPlainObject(entity.components)) throw new ComponentSchemaError('E_COMPONENT_MAP', 'Entity components must be an object');
        entity.components[key] = stored;
      } else if (storage === 'flat-name') entity.name = stored.value;
      else if (storage === 'flat-transform') {
        if (hasOwn(stored, 'x')) entity.x = stored.x;
        if (hasOwn(stored, 'y')) entity.y = stored.y;
        if (hasOwn(stored, 'rotation')) entity[hasOwn(entity, 'rotation') ? 'rotation' : 'rot'] = stored.rotation;
        if (hasOwn(stored, 'scaleX')) entity[hasOwn(entity, 'scaleX') ? 'scaleX' : 'sx'] = stored.scaleX;
        if (hasOwn(stored, 'scaleY')) entity[hasOwn(entity, 'scaleY') ? 'scaleY' : 'sy'] = stored.scaleY;
      } else if (storage === 'transform') entity.transform = stored;
      else if (storage === 'flat-renderable') {
        const fields = {
          kind: 'kind',
          width: hasOwn(entity, 'width') ? 'width' : 'w',
          height: hasOwn(entity, 'height') ? 'height' : 'h',
          color: 'color', assetId: 'assetId', imageSrc: 'imageSrc', layer: 'layer'
        };
        for (const [source, target] of Object.entries(fields)) if (hasOwn(stored, source)) entity[target] = stored[source];
      } else if (storage === 'rigidbody' || storage === 'rigidBody' || storage === 'collider') entity[storage] = stored;
      else if (storage === 'flat-hidden') entity.visible = false;
      else if (storage === 'flat-locked') entity.locked = true;
      else if (storage === 'flat-prefab') {
        entity.prefab = true;
        if (hasOwn(stored, 'assetId')) entity.assetId = stored.assetId;
      }
      else throw new ComponentSchemaError('E_COMPONENT_STORAGE', `Unsupported storage: ${storage}`);
      return normalized;
    }

    _removeStorage(entity, storage, options = {}) {
      if (!storage) return false;
      if (storage.startsWith('components.')) {
        if (!isPlainObject(entity.components)) return false;
        const key = storage.slice('components.'.length);
        if (!hasOwn(entity.components, key)) return false;
        delete entity.components[key];
        return true;
      }
      if (storage === 'flat-hidden') { const existed = entity.visible === false; if (existed) entity.visible = true; return existed; }
      if (storage === 'flat-locked') { const existed = entity.locked === true; if (existed) entity.locked = false; return existed; }
      if (storage === 'flat-prefab') {
        const existed = entity.prefab === true;
        if (!existed) return false;
        const renderable = this._flatRenderable(entity);
        const sharedWithRenderable = Object.keys(renderable.value).some(key => key !== 'assetId');
        entity.prefab = false;
        // Once the Prefab marker is gone, an otherwise unowned legacy assetId
        // would be reinterpreted as an asset-only Renderable. Retain it only
        // when an explicit flat Renderable projection actually shares it.
        if (!options.preservePrefabAsset && !sharedWithRenderable && hasOwn(entity, 'assetId')) delete entity.assetId;
        return true;
      }
      if (storage === 'flat-name') { const existed = hasOwn(entity, 'name'); if (existed) delete entity.name; return existed; }
      if (storage === 'flat-transform') {
        let removed = false;
        for (const key of ['x', 'y', 'rot', 'rotation', 'sx', 'scaleX', 'sy', 'scaleY']) if (hasOwn(entity, key)) { delete entity[key]; removed = true; }
        return removed;
      }
      if (storage === 'flat-renderable') {
        let removed = false;
        for (const key of ['kind', 'w', 'h', 'width', 'height', 'color', 'assetId', 'imageSrc', 'layer']) {
          if (key === 'assetId' && entity.prefab === true) continue;
          if (hasOwn(entity, key)) { delete entity[key]; removed = true; }
        }
        return removed;
      }
      if (hasOwn(entity, storage)) { delete entity[storage]; return true; }
      return false;
    }

    remove(entity, type, options = {}) {
      if (!isPlainObject(entity)) throw new ComponentSchemaError('E_ENTITY_VALUE', 'Entity must be a plain object');
      const canonical = this.registry._requireType(type);
      const descriptor = this.registry.describe(canonical);
      if (descriptor && descriptor.removable === false) throw new ComponentSchemaError('E_REQUIRED_COMPONENT', `${canonical} cannot be removed`, { details: { type: canonical } });
      const resolved = this.resolve(entity, canonical);
      if (!options.allLocations && options.provenance && !this._storageMatches(canonical, options.provenance)) {
        throw new ComponentSchemaError('E_COMPONENT_STORAGE', `Storage ${options.provenance} does not match ${canonical}`, { details: { type: canonical, storage: options.provenance } });
      }
      if (!resolved.found) return false;
      if (options.allLocations) return resolved.candidates.reduce((removed, candidate) => this._removeStorage(entity, candidate.storage) || removed, false);
      return this._removeStorage(entity, options.provenance || resolved.storage);
    }

    decodeToRuntime(entity, options = {}) {
      const diagnostics = this.validate(entity, { ...options, mode: options.mode || 'compat' });
      const errors = diagnostics.filter(item => item.severity === 'error');
      if (errors.length && options.validate !== false) {
        throw new ComponentSchemaError(errors[0].code, errors[0].message, { pointer: errors[0].pointer, diagnostics });
      }
      const components = {};
      const conflicts = [];
      for (const item of this.list(entity)) {
        const normalized = this.registry.normalize(item.type, item.value, {
          ...options,
          profile: PROFILES.RUNTIME,
          filterRuntimeOnly: false,
          applyDefaults: item.type === 'Name' || item.type === 'Transform'
        });
        if (options.validate === false) components[item.type] = normalized;
        else {
          try {
            components[item.type] = this.registry.assert(item.type, normalized, {
              ...options,
              profile: PROFILES.RUNTIME,
              filterRuntimeOnly: false,
              applyDefaults: false,
              normalize: false,
              mode: 'strict',
              pointer: ''
            });
          } catch (error) {
            if (!(error instanceof ComponentSchemaError) || !error.diagnostics.length) throw error;
            const base = options.pointer || '';
            const candidate = { storage: item.storage, rawValue: item.value };
            const diagnostics = error.diagnostics.map(diagnosticItem => ({
              ...diagnosticItem,
              pointer: item.storage && item.storage.startsWith('components.')
                ? `${base}${pointerForStorage(item.storage)}${diagnosticItem.pointer}`
                : this._legacyDiagnosticPointer(entity, candidate, diagnosticItem.pointer, base)
            }));
            const first = diagnostics.find(diagnosticItem => diagnosticItem.severity === 'error') || diagnostics[0];
            throw new ComponentSchemaError(first.code, first.message, { pointer: first.pointer, diagnostics, details: first.details });
          }
        }
        if (item.conflicts.length) conflicts.push({ type: item.type, storage: item.storage, provenance: item.provenance, conflicts: item.conflicts });
      }
      return { id: entity.id, parentId: entity.parentId == null ? null : entity.parentId, components, conflicts };
    }
  }

  function createDefaultEntityCodec(options = {}) {
    if (options instanceof ComponentSchemaRegistry) return new EntityCodec(options);
    const registry = options.registry || createDefaultComponentRegistry(options.registryOptions);
    return new EntityCodec(registry, options);
  }

  const PREFAB_OVERRIDE_OPERATIONS = Object.freeze(['add', 'replace', 'remove']);
  const PREFAB_OVERRIDE_OPERATION_SET = new Set(PREFAB_OVERRIDE_OPERATIONS);
  const UNSAFE_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

  function parseJsonPointer(pointer, options = {}) {
    if (typeof pointer !== 'string') {
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_PATH', 'Prefab override path must be an RFC 6901 JSON Pointer', {
        pointer: options.pointer || '', details: { path: pointer }
      });
    }
    if (pointer === '') {
      if (options.allowRoot) return [];
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_PATH', 'Prefab override path must target a field below the Entity root', {
        pointer: options.pointer || '', details: { path: pointer }
      });
    }
    if (!pointer.startsWith('/')) {
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_PATH', 'Prefab override path must start with /', {
        pointer: options.pointer || '', details: { path: pointer }
      });
    }
    return pointer.slice(1).split('/').map(raw => {
      if (/~(?:[^01]|$)/.test(raw)) {
        throw new ComponentSchemaError('E_PREFAB_OVERRIDE_PATH', 'Prefab override path contains an invalid RFC 6901 escape', {
          pointer: options.pointer || '', details: { path: pointer }
        });
      }
      const decoded = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (UNSAFE_POINTER_SEGMENTS.has(decoded)) {
        throw new ComponentSchemaError('E_PREFAB_OVERRIDE_PATH', `Prefab override path contains an unsafe segment: ${decoded}`, {
          pointer: options.pointer || '', details: { path: pointer, segment: decoded }
        });
      }
      return decoded;
    });
  }

  function prefabOverridePathAllowed(pointer, options = {}) {
    let segments;
    try { segments = parseJsonPointer(pointer, options); }
    catch (error) { return false; }
    // `-` is a normal RFC 6901 object-member name. It is only the transient
    // RFC 6902 append cursor when its resolved parent is an Array, where it
    // cannot provide durable identity for a stored Prefab override.
    if (hasOwn(options, 'target')) {
      let current = options.target;
      for (const segment of segments) {
        if (Array.isArray(current)) {
          if (segment === '-') return false;
          if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= current.length || !hasOwn(current, Number(segment))) break;
          current = current[Number(segment)];
        } else if (current && typeof current === 'object' && hasOwn(current, segment)) current = current[segment];
        else break;
      }
    }
    const first = segments[0];
    if (first === 'id' || first === 'parentId' || first === 'prefab') return false;
    if (first === 'components' && (segments.length === 1 || String(segments[1]).toLowerCase() === 'prefabinstance')) return false;
    return true;
  }

  function prefabRootPlacementPath(pointer) {
    let segments;
    try { segments = parseJsonPointer(pointer); }
    catch (_) { return false; }
    const first = String(segments[0] || '').toLowerCase();
    if (['x', 'y', 'rot', 'rotation', 'sx', 'sy', 'scalex', 'scaley'].includes(first)) return true;
    if (first === 'transform') return true;
    return first === 'components' && String(segments[1] || '').toLowerCase() === 'transform';
  }

  function jsonPointerLookup(target, pointer, options = {}) {
    const segments = Array.isArray(pointer) ? pointer : parseJsonPointer(pointer, { ...options, allowRoot: true });
    if (!segments.length) return { found: true, value: target, parent: null, key: null };
    let current = target;
    for (let index = 0; index < segments.length; index += 1) {
      const key = segments[index];
      if (!current || typeof current !== 'object') return { found: false, value: undefined, parent: null, key };
      if (Array.isArray(current)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) return { found: false, value: undefined, parent: current, key };
        const position = Number(key);
        if (position >= current.length || !hasOwn(current, position)) return { found: false, value: undefined, parent: current, key };
        if (index === segments.length - 1) return { found: true, value: current[position], parent: current, key: position };
        current = current[position];
      } else {
        if (!hasOwn(current, key)) return { found: false, value: undefined, parent: current, key };
        if (index === segments.length - 1) return { found: true, value: current[key], parent: current, key };
        current = current[key];
      }
    }
    return { found: false, value: undefined, parent: null, key: null };
  }

  function applyJsonPointerOperation(target, pointer, operation, options = {}) {
    if (!isPlainObject(target) && !Array.isArray(target)) {
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', 'Prefab override target must be a JSON object or array', {
        pointer: options.pointer || ''
      });
    }
    if (!isPlainObject(operation) || !PREFAB_OVERRIDE_OPERATION_SET.has(operation.op)) {
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_OPERATION', 'Prefab override operation must use add, replace, or remove', {
        pointer: options.pointer || pointer, details: { operation }
      });
    }
    if (operation.op !== 'remove' && !hasOwn(operation, 'value')) {
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_VALUE', `${operation.op} requires a value`, {
        pointer: options.pointer || pointer, details: { operation: operation.op }
      });
    }
    const safety = operation.op === 'remove' ? [] : jsonSafetyDiagnostics(operation.value, options.pointer || pointer);
    if (safety.length) throw new ComponentSchemaError(safety[0].code, safety[0].message, { pointer: safety[0].pointer, diagnostics: safety });
    const segments = parseJsonPointer(pointer, options);
    if (!prefabOverridePathAllowed(pointer, { ...options, target })) {
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_PROTECTED', 'Prefab override cannot change Entity identity, hierarchy, or its PrefabInstance marker', {
        pointer: options.pointer || pointer, details: { path: pointer }
      });
    }
    let parent = target;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const key = segments[index];
      if (!parent || typeof parent !== 'object') {
        throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', `Prefab override parent does not exist: ${pointer}`, {
          pointer: options.pointer || pointer, details: { path: pointer }
        });
      }
      if (Array.isArray(parent)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= parent.length || !hasOwn(parent, Number(key))) {
          throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', `Prefab override parent does not exist: ${pointer}`, {
            pointer: options.pointer || pointer, details: { path: pointer }
          });
        }
        parent = parent[Number(key)];
      } else {
        if (!hasOwn(parent, key)) {
          throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', `Prefab override parent does not exist: ${pointer}`, {
            pointer: options.pointer || pointer, details: { path: pointer }
          });
        }
        parent = parent[key];
      }
    }
    if (!parent || typeof parent !== 'object') {
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', `Prefab override parent does not exist: ${pointer}`, {
        pointer: options.pointer || pointer, details: { path: pointer }
      });
    }
    const rawKey = segments[segments.length - 1];
    if (Array.isArray(parent)) {
      const isAppend = rawKey === '-';
      if (!isAppend && !/^(0|[1-9]\d*)$/.test(rawKey)) {
        throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', `Invalid array index in Prefab override: ${rawKey}`, {
          pointer: options.pointer || pointer, details: { path: pointer, index: rawKey }
        });
      }
      const index = isAppend ? parent.length : Number(rawKey);
      if (operation.op === 'add') {
        if (index > parent.length) throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', `Array index is out of range: ${rawKey}`, { pointer: options.pointer || pointer });
        parent.splice(index, 0, cloneJson(operation.value));
      } else {
        if (isAppend || index >= parent.length || !hasOwn(parent, index)) {
          throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', `Prefab override target does not exist: ${pointer}`, {
            pointer: options.pointer || pointer, details: { path: pointer }
          });
        }
        if (operation.op === 'replace') parent[index] = cloneJson(operation.value);
        else parent.splice(index, 1);
      }
      return target;
    }
    const exists = hasOwn(parent, rawKey);
    if (operation.op !== 'add' && !exists) {
      throw new ComponentSchemaError('E_PREFAB_OVERRIDE_TARGET', `Prefab override target does not exist: ${pointer}`, {
        pointer: options.pointer || pointer, details: { path: pointer }
      });
    }
    if (operation.op === 'remove') delete parent[rawKey];
    else defineJsonProperty(parent, rawKey, cloneJson(operation.value));
    return target;
  }

  function applyPrefabOverrideOperation(target, pointer, operation, options = {}) {
    const segments = parseJsonPointer(pointer, options);
    // A connected Instance necessarily owns a components map for its marker,
    // while a compact Asset source may have no components at all. Allow the
    // first whole-component add to materialize that one canonical container;
    // every deeper missing parent keeps strict RFC 6901 behavior.
    if (operation?.op === 'add' && segments.length === 2 && segments[0] === 'components' &&
        isPlainObject(target) && !hasOwn(target, 'components')) {
      // Preflight the complete operation before materializing the synthetic
      // container so a rejected public helper call remains failure-atomic.
      applyJsonPointerOperation({ components: {} }, pointer, operation, options);
      defineJsonProperty(target, 'components', {});
    }
    return applyJsonPointerOperation(target, pointer, operation, options);
  }

  function markerPointer(base, resolved) {
    return `${base}${pointerForStorage(resolved.storage)}`;
  }

  function lifecyclePrefabMarker(entity, codec) {
    let resolved;
    try { resolved = codec.resolve(entity, 'PrefabInstance'); }
    catch (_) { return null; }
    if (!resolved.found || !isPlainObject(resolved.value)) return null;
    const value = resolved.value;
    // `prefabId`-only components existed before the expanded instance
    // contract. They remain opaque legacy authoring data; an instance enters
    // the lifecycle contract only when it declares member/root identity.
    const lifecycle = ['sourceEntityId', 'instanceRootId'].some(key => hasOwn(value, key) && value[key] != null);
    return lifecycle ? { resolved, value } : null;
  }

  function comparablePrefabEntity(entity, codec, rootPlacement = false) {
    const comparable = cloneJson(entity);
    codec.remove(comparable, 'PrefabInstance', { allLocations: true });
    delete comparable.id;
    delete comparable.parentId;
    if (rootPlacement) {
      // Transform is required and therefore cannot be removed through the
      // public codec API. Strip every resolved authoring location manually so
      // aliases/case variants such as components.TRANSFORM remain placement.
      const resolved = codec.resolve(comparable, 'Transform');
      for (const candidate of resolved.candidates) {
        if (candidate.storage.startsWith('components.')) {
          if (isPlainObject(comparable.components)) delete comparable.components[candidate.storage.slice('components.'.length)];
        } else if (candidate.storage === 'transform') delete comparable.transform;
        else if (candidate.storage === 'flat-transform') {
          for (const key of ['x', 'y', 'rot', 'rotation', 'sx', 'sy', 'scaleX', 'scaleY']) delete comparable[key];
        }
      }
    }
    if (isPlainObject(comparable.components) && Object.keys(comparable.components).length === 0) delete comparable.components;
    return comparable;
  }

  function validatePrefabOverrides(overrides, pointer, options, output) {
    if (!isPlainObject(overrides)) {
      output.push(diagnostic('E_PREFAB_OVERRIDES_TYPE', 'PrefabInstance.overrides must be a plain object', pointer));
      return;
    }
    const acceptedPaths = [];
    for (const [path, operation] of Object.entries(overrides)) {
      const operationPointer = joinPointer(pointer, path);
      try { parseJsonPointer(path, { pointer: operationPointer }); }
      catch (error) {
        output.push(diagnostic(error.code || 'E_PREFAB_OVERRIDE_PATH', error.message, operationPointer, error.details));
        continue;
      }
      if (!prefabOverridePathAllowed(path)) {
        output.push(diagnostic('E_PREFAB_OVERRIDE_PROTECTED', 'Prefab override cannot change Entity identity, hierarchy, or its PrefabInstance marker', operationPointer, { path }));
      } else {
        const conflict = acceptedPaths.find(existing => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`));
        if (conflict) output.push(diagnostic(
          'E_PREFAB_OVERRIDE_CONFLICT',
          'Prefab override paths cannot overlap through an ancestor or descendant path',
          operationPointer,
          { path, conflictingPath: conflict }
        ));
        else acceptedPaths.push(path);
      }
      if (!isPlainObject(operation) || !PREFAB_OVERRIDE_OPERATION_SET.has(operation.op)) {
        output.push(diagnostic(
          options.strict ? 'E_PREFAB_OVERRIDE_OPERATION' : 'W_PREFAB_OVERRIDE_LEGACY',
          options.strict ? 'Prefab override must use a canonical add, replace, or remove operation' : 'Legacy Prefab override value is preserved but not applied by the lifecycle API',
          operationPointer,
          { path },
          options.strict ? 'error' : 'warning'
        ));
        continue;
      }
      if (operation.op !== 'remove' && !hasOwn(operation, 'value')) {
        output.push(diagnostic('E_PREFAB_OVERRIDE_VALUE', `${operation.op} requires a value`, operationPointer, { path, operation: operation.op }));
      } else if (operation.op !== 'remove') output.push(...jsonSafetyDiagnostics(operation.value, joinPointer(operationPointer, 'value')));
    }
  }

  function validatePrefabDocument(document, options = {}) {
    const output = [];
    if (!isPlainObject(document)) return [diagnostic('E_PREFAB_DOCUMENT', 'Project document must be a plain object', '')];
    const codec = options.entityCodec instanceof EntityCodec ? options.entityCodec : createDefaultEntityCodec();
    // Legacy projects may still contain the old top-level `prefab` workspace.
    // It is intentionally not interpreted as a reusable asset definition, but
    // a complete expanded marker must still fail if no `prefabs` Asset exists.
    const prefabs = document.prefabs == null ? [] : document.prefabs;
    if (!Array.isArray(prefabs)) return [diagnostic('E_PREFABS_TYPE', 'prefabs must be an array', '/prefabs')];

    const assetById = new Map();
    const assetEntities = new Map();
    prefabs.forEach((asset, assetIndex) => {
      const base = `/prefabs/${assetIndex}`;
      if (!isPlainObject(asset)) {
        output.push(diagnostic('E_PREFAB_ASSET_TYPE', 'Prefab Asset must be a plain object', base));
        return;
      }
      if (typeof asset.id !== 'string' || !asset.id.trim()) output.push(diagnostic('E_PREFAB_ID', 'Prefab Asset id must be a non-empty string', `${base}/id`));
      else if (assetById.has(asset.id)) output.push(diagnostic('E_PREFAB_ID_DUPLICATE', `Duplicate Prefab Asset id: ${asset.id}`, `${base}/id`, { firstPointer: assetById.get(asset.id).pointer }));
      else assetById.set(asset.id, { asset, pointer: base });
      if (asset.name != null && typeof asset.name !== 'string') output.push(diagnostic('E_PREFAB_NAME', 'Prefab Asset name must be a string', `${base}/name`));
      if (typeof asset.rootEntityId !== 'string' || !asset.rootEntityId.trim()) output.push(diagnostic('E_PREFAB_ROOT_ID', 'Prefab Asset rootEntityId must be a non-empty string', `${base}/rootEntityId`));
      if (asset.revision != null && (!Number.isInteger(asset.revision) || asset.revision < 0)) output.push(diagnostic('E_PREFAB_REVISION', 'Prefab Asset revision must be a non-negative integer', `${base}/revision`));
      if (!Array.isArray(asset.entities) || asset.entities.length === 0) {
        output.push(diagnostic('E_PREFAB_ENTITIES', 'Prefab Asset entities must be a non-empty array', `${base}/entities`));
        return;
      }
      const byId = new Map();
      const idPointers = new Map();
      asset.entities.forEach((entity, entityIndex) => {
        const pointer = `${base}/entities/${entityIndex}`;
        if (!isPlainObject(entity)) {
          output.push(diagnostic('E_PREFAB_ENTITY_TYPE', 'Prefab Entity must be a plain object', pointer));
          return;
        }
        output.push(...codec.validate(entity, { pointer, profile: PROFILES.AUTHORING, mode: options.strict ? 'strict' : 'compat', strict: Boolean(options.strict) }));
        if (typeof entity.id !== 'string' || !entity.id.trim()) return;
        if (byId.has(entity.id)) output.push(diagnostic('E_PREFAB_ENTITY_ID_DUPLICATE', `Duplicate Prefab Entity id: ${entity.id}`, `${pointer}/id`, { firstPointer: idPointers.get(entity.id) }));
        else { byId.set(entity.id, entity); idPointers.set(entity.id, `${pointer}/id`); }
        const nested = lifecyclePrefabMarker(entity, codec);
        if (nested) output.push(diagnostic('E_PREFAB_NESTED_INSTANCE', 'Nested Prefab instances inside a Prefab Asset are not supported by this contract', markerPointer(pointer, nested.resolved)));
      });
      assetEntities.set(asset.id, byId);
      const root = byId.get(asset.rootEntityId);
      if (!root) {
        output.push(diagnostic('E_PREFAB_ROOT_MISSING', `Prefab root Entity does not exist: ${asset.rootEntityId || '(missing)'}`, `${base}/rootEntityId`));
        return;
      }
      if (root.parentId != null) output.push(diagnostic('E_PREFAB_ROOT_PARENT', 'Prefab root Entity must not have a parent inside its Asset', `${base}/entities/${asset.entities.indexOf(root)}/parentId`));
      for (const entity of byId.values()) {
        if (entity.id !== asset.rootEntityId && (typeof entity.parentId !== 'string' || !entity.parentId.trim())) {
          output.push(diagnostic('E_PREFAB_DISCONNECTED', `Prefab Entity must descend from root ${asset.rootEntityId}`, idPointers.get(entity.id), { entityId: entity.id }));
          continue;
        }
        if (entity.parentId != null && !byId.has(entity.parentId)) {
          output.push(diagnostic('E_PREFAB_DANGLING_PARENT', `Prefab parent does not exist: ${entity.parentId}`, `${base}/entities/${asset.entities.indexOf(entity)}/parentId`, { entityId: entity.id, parentId: entity.parentId }));
          continue;
        }
        const seen = new Set([entity.id]);
        let cursor = entity;
        let cycle = false;
        while (cursor && cursor.parentId != null) {
          const parentId = cursor.parentId;
          if (seen.has(parentId)) {
            output.push(diagnostic('E_PREFAB_PARENT_CYCLE', `Prefab parent cycle contains ${parentId}`, `${base}/entities/${asset.entities.indexOf(cursor)}/parentId`, { entityId: entity.id }));
            cycle = true;
            break;
          }
          seen.add(parentId);
          cursor = byId.get(parentId);
          if (!cursor) break;
        }
        if (!cycle && entity.id !== asset.rootEntityId && cursor && cursor.id !== asset.rootEntityId) {
          output.push(diagnostic('E_PREFAB_DISCONNECTED', `Prefab Entity must descend from root ${asset.rootEntityId}`, idPointers.get(entity.id), { entityId: entity.id }));
        }
      }
    });

    const scopes = [];
    if (Array.isArray(document.scenes)) {
      document.scenes.forEach((scene, sceneIndex) => {
        if (isPlainObject(scene) && Array.isArray(scene.objects)) scopes.push({ entities: scene.objects, pointer: `/scenes/${sceneIndex}/objects`, sceneId: scene.id });
      });
    } else {
      const entities = Array.isArray(document.scene) ? document.scene : (Array.isArray(document.entities) ? document.entities : null);
      if (entities) scopes.push({ entities, pointer: Array.isArray(document.scene) ? '/scene' : '/entities', sceneId: null });
    }

    for (const scope of scopes) {
      const sceneById = new Map(scope.entities.filter(isPlainObject).map(entity => [entity.id, entity]));
      const groups = new Map();
      scope.entities.forEach((entity, entityIndex) => {
        if (!isPlainObject(entity)) return;
        const memberBase = `${scope.pointer}/${entityIndex}`;
        const marker = lifecyclePrefabMarker(entity, codec);
        if (!marker) return;
        const value = marker.value;
        const base = markerPointer(memberBase, marker.resolved);
        for (const key of ['prefabId', 'sourceEntityId', 'instanceRootId']) {
          if (typeof value[key] !== 'string' || !value[key].trim()) output.push(diagnostic('E_PREFAB_INSTANCE_ID', `PrefabInstance.${key} must be a non-empty string`, `${base}/${key}`, { field: key }));
        }
        if (!Number.isInteger(value.prefabRevision) || value.prefabRevision < 0) output.push(diagnostic('E_PREFAB_INSTANCE_REVISION', 'PrefabInstance.prefabRevision must be a non-negative integer', `${base}/prefabRevision`));
        validatePrefabOverrides(value.overrides == null ? {} : value.overrides, `${base}/overrides`, options, output);
        if (entity.id === value.instanceRootId && isPlainObject(value.overrides)) {
          for (const path of Object.keys(value.overrides)) {
            if (prefabRootPlacementPath(path)) output.push(diagnostic(
              'E_PREFAB_PLACEMENT_PATH',
              'Transform fields on an instance root are placement and cannot be stored as Prefab overrides',
              joinPointer(`${base}/overrides`, path),
              { path }
            ));
          }
        }
        if (typeof value.prefabId !== 'string' || typeof value.sourceEntityId !== 'string' || typeof value.instanceRootId !== 'string') return;
        const assetRecord = assetById.get(value.prefabId);
        if (!assetRecord) {
          output.push(diagnostic('E_PREFAB_INSTANCE_ASSET_MISSING', `Prefab Asset does not exist: ${value.prefabId}`, `${base}/prefabId`, { prefabId: value.prefabId }));
          return;
        }
        const sourceById = assetEntities.get(value.prefabId) || new Map();
        const assetRevision = assetRecord.asset.revision;
        const staleRevision = Number.isInteger(assetRevision) && Number.isInteger(value.prefabRevision) && value.prefabRevision !== assetRevision;
        if (!sourceById.has(value.sourceEntityId)) output.push(diagnostic('E_PREFAB_INSTANCE_SOURCE_MISSING', `Prefab source Entity does not exist: ${value.sourceEntityId}`, `${base}/sourceEntityId`, { prefabId: value.prefabId, sourceEntityId: value.sourceEntityId }));
        else if (isPlainObject(value.overrides)) {
          const source = sourceById.get(value.sourceEntityId);
          const projected = cloneJson(source);
          for (const [path, operation] of Object.entries(value.overrides)) {
            if (!isPlainObject(operation) || !PREFAB_OVERRIDE_OPERATION_SET.has(operation.op) || !prefabOverridePathAllowed(path)) continue;
            // A stale marker was authored against an unavailable historical
            // Asset revision. Canonical shape is still validated above, but
            // add/replace/remove compatibility cannot be inferred safely from
            // the current Asset source.
            if (staleRevision) continue;
            let sourceValue;
            try { sourceValue = jsonPointerLookup(source, path); } catch (_) { continue; }
            const expected = sourceValue.found ? ['replace', 'remove'] : ['add'];
            if (!expected.includes(operation.op)) output.push(diagnostic(
              'E_PREFAB_OVERRIDE_SOURCE',
              `Prefab override ${operation.op} is incompatible with the Asset source path`,
              joinPointer(`${base}/overrides`, path),
              { path, operation: operation.op, sourceExists: sourceValue.found, allowed: expected }
            ));
            else {
              try { applyPrefabOverrideOperation(projected, path, operation); }
              catch (error) {
                output.push(diagnostic(
                  error.code || 'E_PREFAB_OVERRIDE_TARGET',
                  error.message,
                  joinPointer(`${base}/overrides`, path),
                  { path, ...(error.details || {}) }
                ));
              }
            }
          }
        }
        if (!sceneById.has(value.instanceRootId)) output.push(diagnostic('E_PREFAB_INSTANCE_ROOT_MISSING', `Prefab instance root does not exist: ${value.instanceRootId}`, `${base}/instanceRootId`, { instanceRootId: value.instanceRootId }));
        if (staleRevision) {
          output.push(diagnostic('W_PREFAB_INSTANCE_STALE', `Prefab instance revision ${value.prefabRevision} differs from Asset revision ${assetRevision}`, `${base}/prefabRevision`, { prefabId: value.prefabId, assetRevision, instanceRevision: value.prefabRevision }, 'warning'));
        }
        const groupKey = `${value.prefabId}\u0000${value.instanceRootId}`;
        const group = groups.get(groupKey) || { prefabId: value.prefabId, rootId: value.instanceRootId, asset: assetRecord.asset, sourceById, members: [], bySource: new Map(), revision: value.prefabRevision };
        if (group.members.length && group.revision !== value.prefabRevision) output.push(diagnostic(
          'E_PREFAB_INSTANCE_REVISION_MISMATCH',
          'Every member of an expanded Prefab instance must use the same prefabRevision',
          `${base}/prefabRevision`,
          { prefabId: value.prefabId, instanceRootId: value.instanceRootId, expectedRevision: group.revision, actualRevision: value.prefabRevision }
        ));
        if (group.bySource.has(value.sourceEntityId)) output.push(diagnostic('E_PREFAB_INSTANCE_SOURCE_DUPLICATE', `Prefab source Entity is mapped more than once in the same instance: ${value.sourceEntityId}`, `${base}/sourceEntityId`, { firstEntityId: group.bySource.get(value.sourceEntityId).entity.id }));
        else group.bySource.set(value.sourceEntityId, { entity, marker: value, pointer: base });
        group.members.push({ entity, marker: value, pointer: base });
        groups.set(groupKey, group);
      });
      for (let entityIndex = 0; entityIndex < scope.entities.length; entityIndex += 1) {
        const entity = scope.entities[entityIndex];
        if (!isPlainObject(entity) || entity.parentId == null) continue;
        const parent = sceneById.get(entity.parentId);
        const parentMarker = parent && lifecyclePrefabMarker(parent, codec);
        if (!parentMarker) continue;
        const childMarker = lifecyclePrefabMarker(entity, codec);
        const belongsToParentInstance = childMarker &&
          childMarker.value.prefabId === parentMarker.value.prefabId &&
          childMarker.value.instanceRootId === parentMarker.value.instanceRootId;
        if (!belongsToParentInstance) output.push(diagnostic(
          'E_PREFAB_STRUCTURAL_EDIT',
          'A connected Prefab member cannot own an authored child outside its expanded instance',
          `${scope.pointer}/${entityIndex}/parentId`,
          {
            entityId: entity.id,
            parentId: entity.parentId,
            prefabId: parentMarker.value.prefabId,
            instanceRootId: parentMarker.value.instanceRootId
          }
        ));
      }
      for (const group of groups.values()) {
        const rootMember = group.members.find(member => member.entity.id === group.rootId);
        if (!rootMember || rootMember.marker.sourceEntityId !== group.asset.rootEntityId) {
          output.push(diagnostic('E_PREFAB_INSTANCE_ROOT_MAPPING', `Instance root must map Prefab source root ${group.asset.rootEntityId}`, rootMember ? `${rootMember.pointer}/sourceEntityId` : scope.pointer, { prefabId: group.prefabId, instanceRootId: group.rootId }));
        }
        for (const source of group.sourceById.values()) {
          const member = group.bySource.get(source.id);
          if (!member) {
            output.push(diagnostic('E_PREFAB_INSTANCE_MEMBER_MISSING', `Expanded Prefab instance is missing source Entity ${source.id}`, scope.pointer, { prefabId: group.prefabId, instanceRootId: group.rootId, sourceEntityId: source.id }));
            continue;
          }
          if (source.id === group.asset.rootEntityId) continue;
          const parentMember = group.bySource.get(source.parentId);
          if (parentMember && member.entity.parentId !== parentMember.entity.id) {
            output.push(diagnostic('E_PREFAB_INSTANCE_HIERARCHY', `Expanded Prefab member ${member.entity.id} has the wrong parent`, `${member.pointer.replace(/\/components\/PrefabInstance$/, '')}/parentId`, { expectedParentId: parentMember.entity.id, actualParentId: member.entity.parentId ?? null }));
          }
        }
        const assetRevision = Number.isInteger(group.asset.revision) ? group.asset.revision : 0;
        for (const source of group.sourceById.values()) {
          const member = group.bySource.get(source.id);
          if (!member || member.marker.prefabRevision !== assetRevision || !isPlainObject(member.marker.overrides)) continue;
          let expected = cloneJson(source);
          let comparable = true;
          for (const [path, operation] of Object.entries(member.marker.overrides)) {
            if (!isPlainObject(operation) || !PREFAB_OVERRIDE_OPERATION_SET.has(operation.op) || !prefabOverridePathAllowed(path)) {
              comparable = false;
              break;
            }
            try { applyPrefabOverrideOperation(expected, path, operation); }
            catch (_) { comparable = false; break; }
          }
          if (!comparable) continue;
          const rootPlacement = source.id === group.asset.rootEntityId;
          expected = comparablePrefabEntity(expected, codec, rootPlacement);
          const actual = comparablePrefabEntity(member.entity, codec, rootPlacement);
          if (!sameValue(expected, actual)) output.push(diagnostic(
            'E_PREFAB_INSTANCE_STATE',
            'Expanded Prefab member does not match its Asset source plus recorded overrides',
            member.pointer.replace(/\/components\/PrefabInstance$/, ''),
            { prefabId: group.prefabId, instanceRootId: group.rootId, entityId: member.entity.id, sourceEntityId: source.id }
          ));
        }
      }
    }
    return output;
  }

  function assertPrefabDocument(document, options = {}) {
    const diagnostics = validatePrefabDocument(document, options);
    const errors = diagnostics.filter(item => item.severity === 'error');
    if (errors.length) {
      const first = errors[0];
      throw new ComponentSchemaError(first.code, first.message, { pointer: first.pointer, details: first.details, diagnostics });
    }
    return diagnostics;
  }

  const BUILTIN_COMPONENT_DEFINITIONS = deepFreeze(BUILTIN_DEFINITIONS.map(definition => {
    const registry = new ComponentSchemaRegistry();
    registry.register(definition);
    return registry.describe(definition.type);
  }));
  deepFreeze(COMPONENT_SCHEMAS);
  deepFreeze(PROFILE_SCHEMAS);
  deepFreeze(ENTITY_SCHEMA);
  deepFreeze(PREFAB_ASSET_SCHEMA);
  deepFreeze(ANIMATION_KEYFRAME_SCHEMA);
  deepFreeze(ANIMATION_TRACK_SCHEMA);
  deepFreeze(ANIMATION_CLIP_SCHEMA);
  deepFreeze(JSON_SCHEMAS);

  return Object.freeze({
    DATA_MODEL_ID,
    DATA_MODEL_VERSION,
    COMPONENT_SCHEMA_VERSION,
    PROFILES,
    PROFILE_NAMES,
    COMPONENT_NAME_PATTERN,
    ANIMATION_TRACK_TYPES,
    ComponentSchemaError,
    ComponentSchemaRegistry,
    EntityCodec,
    BUILTIN_COMPONENT_DEFINITIONS,
    COMPONENT_DEFINITIONS: BUILTIN_COMPONENT_DEFINITIONS,
    COMPONENT_SCHEMAS,
    PROFILE_SCHEMAS,
    COMPONENT_MAP_SCHEMA,
    ENTITY_SCHEMA,
    PREFAB_ASSET_SCHEMA,
    ANIMATION_KEYFRAME_SCHEMA,
    ANIMATION_TRACK_SCHEMA,
    ANIMATION_CLIP_SCHEMA,
    JSON_SCHEMAS,
    PREFAB_OVERRIDE_OPERATIONS,
    isSafeComponentName,
    parseJsonPointer,
    prefabOverridePathAllowed,
    prefabRootPlacementPath,
    jsonPointerLookup,
    applyJsonPointerOperation,
    applyPrefabOverrideOperation,
    validatePrefabDocument,
    assertPrefabDocument,
    normalizeAnimationClip,
    normalizeAnimationClips,
    sampleAnimationClip,
    validateAnimationDocument,
    assertAnimationDocument,
    validateSkeletonDocument,
    assertSkeletonDocument,
    createDefaultComponentRegistry,
    createDefaultEntityCodec
  });
});
