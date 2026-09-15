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
  const PARTICLE_CURVE_PROPERTIES = Object.freeze(['emission', 'scale', 'speed', 'opacity', 'hue']);
  const PARTICLE_CURVE_INTERPOLATIONS = Object.freeze(['linear', 'step', 'cubic']);
  const SHADER_NODE_TYPES = Object.freeze([
    'sceneTexture', 'output', 'tint', 'grayscale', 'brightnessContrast',
    'saturation', 'invert', 'vignette', 'pixelate', 'chromaticAberration', 'mix'
  ]);
  const SHADER_VALUE_TYPES = Object.freeze(['color']);
  const SHADER_HEX_COLOR_PATTERN = '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$';
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
  const PARTICLE_EMITTER_AUTHORING_SCHEMA = object({
    // Empty/missing values are classified by cross-resource validation so
    // legacy inline emitters can remain compatible without weakening new ones.
    assetId: string(),
    autoplay: boolean(), playing: boolean(), loop: boolean(), time: number({ minimum: 0 }), speed: number({ minimum: 0 }), emitting: boolean(),
    overrides: object(), seed: integer({ minimum: 0 }),
    // Legacy inline emitter configuration remains describable and lossless;
    // canonical authoring uses assetId plus the playback fields above.
    name: string(), amount: integer({ minimum: 0 }), rate: number({ minimum: 0 }), lifetime: number({ minimum: 0 }),
    spread: number(), gravity: number(), radius: number({ minimum: 0 }), scale: number({ minimum: 0 }),
    opacity: number({ minimum: 0, maximum: 1 }), hue: number(), blend: string()
  });
  const PARTICLE_RUNTIME_RECORD_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    x: number(), y: number(), vx: number(), vy: number(), age: number({ minimum: 0 }), lifetime: number({ minimum: 0 }), rotation: number(),
    baseScale: number({ minimum: 0 }), baseOpacity: number({ minimum: 0, maximum: 1 }), baseHue: number(),
    scale: number({ minimum: 0 }), opacity: number({ minimum: 0, maximum: 1 }), hue: number()
  });
  const PARTICLE_EMITTER_RUNTIME_SCHEMA = object({
    ...PARTICLE_EMITTER_AUTHORING_SCHEMA.properties,
    particles: { type: 'array', items: PARTICLE_RUNTIME_RECORD_SCHEMA },
    emissionAccumulator: number({ minimum: 0 }), completed: boolean(), rngState: integer({ minimum: 0 })
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
    ParticleEmitter: profileSet(PARTICLE_EMITTER_AUTHORING_SCHEMA, PARTICLE_EMITTER_RUNTIME_SCHEMA),
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
  const PARTICLE_CURVE_KEY_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    time: number({ minimum: 0, maximum: 1 }),
    value: number(),
    inTangent: number(),
    outTangent: number()
  }, { required: ['id', 'time', 'value'] });
  const PARTICLE_CURVE_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    property: { type: 'string', enum: PARTICLE_CURVE_PROPERTIES },
    interpolation: { type: 'string', enum: PARTICLE_CURVE_INTERPOLATIONS },
    keys: { type: 'array', items: PARTICLE_CURVE_KEY_SCHEMA }
  }, { required: ['id', 'property', 'interpolation', 'keys'] });
  const PARTICLE_ASSET_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    name: string({ minLength: 1, pattern: '\\S' }),
    duration: number({ exclusiveMinimum: 0 }),
    loop: boolean(),
    maxParticles: integer({ minimum: 0 }),
    emission: object({
      rate: number({ minimum: 0 }), burst: integer({ minimum: 0 })
    }, { required: ['rate', 'burst'] }),
    lifetime: object({
      min: number({ minimum: 0 }), max: number({ minimum: 0 })
    }, { required: ['min', 'max'] }),
    velocity: object({
      speedMin: number({ minimum: 0 }), speedMax: number({ minimum: 0 }), angle: number(), spread: number({ minimum: 0 }),
      gravityX: number(), gravityY: number()
    }, { required: ['speedMin', 'speedMax', 'angle', 'spread', 'gravityX', 'gravityY'] }),
    shape: object({
      type: { type: 'string', enum: ['point', 'circle', 'box'] },
      radius: number({ minimum: 0 }), width: number({ minimum: 0 }), height: number({ minimum: 0 })
    }, { required: ['type', 'radius', 'width', 'height'] }),
    appearance: object({
      assetId: nullableString(), color: string({ minLength: 1 }), blend: { type: 'string', enum: ['normal', 'additive'] },
      baseScale: number({ minimum: 0 }), baseOpacity: number({ minimum: 0, maximum: 1 }), baseHue: number()
    }, { required: ['color', 'blend', 'baseScale', 'baseOpacity', 'baseHue'] }),
    curves: { type: 'array', items: PARTICLE_CURVE_SCHEMA }
  }, { required: ['id', 'name', 'duration', 'loop', 'maxParticles', 'emission', 'lifetime', 'velocity', 'shape', 'appearance', 'curves'] });
  const SHADER_NODE_DEFINITIONS = {
    sceneTexture: {
      inputs: {}, outputs: { color: 'color' }, parameters: {}
    },
    output: {
      inputs: { color: 'color' }, outputs: {}, parameters: {}
    },
    tint: {
      inputs: { color: 'color' }, outputs: { color: 'color' },
      parameters: { color: { type: 'string', pattern: SHADER_HEX_COLOR_PATTERN, default: '#ffffff' }, amount: { type: 'number', default: 1, minimum: 0, maximum: 1 } }
    },
    grayscale: {
      inputs: { color: 'color' }, outputs: { color: 'color' },
      parameters: { amount: { type: 'number', default: 1, minimum: 0, maximum: 1 } }
    },
    brightnessContrast: {
      inputs: { color: 'color' }, outputs: { color: 'color' },
      parameters: {
        brightness: { type: 'number', default: 0, minimum: -1, maximum: 1 },
        contrast: { type: 'number', default: 1, minimum: 0, maximum: 2 }
      }
    },
    saturation: {
      inputs: { color: 'color' }, outputs: { color: 'color' },
      parameters: { amount: { type: 'number', default: 1, minimum: 0, maximum: 2 } }
    },
    invert: {
      inputs: { color: 'color' }, outputs: { color: 'color' },
      parameters: { amount: { type: 'number', default: 1, minimum: 0, maximum: 1 } }
    },
    vignette: {
      inputs: { color: 'color' }, outputs: { color: 'color' },
      parameters: {
        intensity: { type: 'number', default: 0.35, minimum: 0, maximum: 1 },
        radius: { type: 'number', default: 0.75, minimum: 0, maximum: 1 },
        softness: { type: 'number', default: 0.5, minimum: 0, maximum: 1 }
      }
    },
    pixelate: {
      inputs: { color: 'color' }, outputs: { color: 'color' },
      parameters: { size: { type: 'number', default: 4, minimum: 1 } }
    },
    chromaticAberration: {
      inputs: { color: 'color' }, outputs: { color: 'color' },
      parameters: { amount: { type: 'number', default: 2, minimum: 0 } }
    },
    mix: {
      inputs: { a: 'color', b: 'color' }, outputs: { color: 'color' },
      parameters: { factor: { type: 'number', default: 0.5, minimum: 0, maximum: 1 } }
    }
  };
  const SHADER_PORT_SCHEMA = object({
    nodeId: string({ minLength: 1, pattern: '\\S' }),
    port: string({ minLength: 1, pattern: '\\S' })
  }, { required: ['nodeId', 'port'] });
  const SHADER_NODE_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    type: string({ minLength: 1, pattern: '\\S' }),
    position: object({ x: number(), y: number() }, { required: ['x', 'y'] }),
    parameters: object()
  }, { required: ['id', 'type', 'position', 'parameters'] });
  const SHADER_LINK_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    from: SHADER_PORT_SCHEMA,
    to: SHADER_PORT_SCHEMA
  }, { required: ['id', 'from', 'to'] });
  const SHADER_GRAPH_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    name: string({ minLength: 1, pattern: '\\S' }),
    version: { const: 1 },
    domain: { const: 'postProcess' },
    nodes: { type: 'array', items: SHADER_NODE_SCHEMA, minItems: 2 },
    links: { type: 'array', items: SHADER_LINK_SCHEMA, minItems: 1 },
    outputNodeId: string({ minLength: 1, pattern: '\\S' })
  }, { required: ['id', 'name', 'version', 'domain', 'nodes', 'links', 'outputNodeId'] });
  const POST_PROCESS_EFFECT_SCHEMA = object({
    id: string({ minLength: 1, pattern: '\\S' }),
    type: string({ minLength: 1, pattern: '\\S' }),
    name: string(),
    enabled: boolean(),
    graphId: string({ minLength: 1, pattern: '\\S' }),
    parameters: object()
  }, { required: ['id', 'type'] });
  const POST_PROCESS_SCHEMA = object({
    enabled: boolean(),
    effects: { type: 'array', items: POST_PROCESS_EFFECT_SCHEMA }
  }, { required: ['effects'] });
  const JSON_SCHEMAS = {
    components: COMPONENT_SCHEMAS,
    componentProfiles: PROFILE_SCHEMAS,
    componentMap: COMPONENT_MAP_SCHEMA,
    entity: ENTITY_SCHEMA,
    prefabOverrideOperation: PREFAB_OVERRIDE_OPERATION_SCHEMA,
    prefabAsset: PREFAB_ASSET_SCHEMA,
    animationKeyframe: ANIMATION_KEYFRAME_SCHEMA,
    animationTrack: ANIMATION_TRACK_SCHEMA,
    animationClip: ANIMATION_CLIP_SCHEMA,
    particleCurveKey: PARTICLE_CURVE_KEY_SCHEMA,
    particleCurve: PARTICLE_CURVE_SCHEMA,
    particleAsset: PARTICLE_ASSET_SCHEMA,
    shaderPort: SHADER_PORT_SCHEMA,
    shaderNode: SHADER_NODE_SCHEMA,
    shaderLink: SHADER_LINK_SCHEMA,
    shaderGraph: SHADER_GRAPH_SCHEMA,
    postProcessEffect: POST_PROCESS_EFFECT_SCHEMA,
    postProcess: POST_PROCESS_SCHEMA
  };

  const SHADER_GRAPH_DEFAULTS = deepFreeze({
    version: 1,
    domain: 'postProcess',
    nodes: [
      { id: 'scene', type: 'sceneTexture', position: { x: 80, y: 160 }, parameters: {} },
      { id: 'output', type: 'output', position: { x: 520, y: 160 }, parameters: {} }
    ],
    links: [
      { id: 'scene-color-output-color', from: { nodeId: 'scene', port: 'color' }, to: { nodeId: 'output', port: 'color' } }
    ],
    outputNodeId: 'output'
  });

  function shaderSlug(value, fallback = 'shader') {
    const slug = String(value == null ? '' : value)
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || fallback;
  }

  function shaderGeneratedId(base, used, fallback = 'shader') {
    const stem = shaderSlug(base, fallback);
    let candidate = stem;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${stem}-${suffix++}`;
    used.add(candidate);
    return candidate;
  }

  function shaderCanonicalType(value, fallback = 'tint') {
    const authored = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    const canonical = SHADER_NODE_TYPES.find(type => type.toLowerCase() === authored.toLowerCase());
    return canonical || authored;
  }

  function shaderFinite(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return fallback;
  }

  function normalizeShaderGraph(input, options = {}) {
    if (Number.isInteger(options)) options = { index: options };
    const source = isPlainObject(input) ? cloneJson(input) : {};
    const output = source;
    const index = Number.isInteger(options.index) && options.index >= 0 ? options.index : 0;
    const name = typeof source.name === 'string' && source.name.trim()
      ? source.name.trim()
      : (typeof source.id === 'string' && source.id.trim() ? source.id.trim() : `Shader Graph ${index + 1}`);
    output.id = typeof source.id === 'string' && source.id.trim()
      ? source.id.trim()
      : shaderSlug(name, `shader-graph-${index + 1}`);
    output.name = name;
    output.version = 1;
    output.domain = 'postProcess';

    const rawNodes = Array.isArray(source.nodes) ? source.nodes.filter(isPlainObject) : [];
    const seededDefault = rawNodes.length === 0;
    if (seededDefault) rawNodes.push(...cloneJson(SHADER_GRAPH_DEFAULTS.nodes));
    const reservedNodeIds = new Set(rawNodes
      .map(node => typeof node.id === 'string' ? node.id.trim() : '')
      .filter(Boolean));
    const usedNodeIds = new Set(reservedNodeIds);
    output.nodes = rawNodes.map((rawNode, nodeIndex) => {
      const node = cloneJson(rawNode);
      node.type = shaderCanonicalType(node.type, nodeIndex === 0 ? 'sceneTexture' : 'tint');
      if (typeof node.id === 'string' && node.id.trim()) node.id = node.id.trim();
      else node.id = shaderGeneratedId(node.type, usedNodeIds, `node-${nodeIndex + 1}`);
      const position = isPlainObject(node.position) ? cloneJson(node.position) : {};
      position.x = shaderFinite(position.x, 80 + (nodeIndex * 220));
      position.y = shaderFinite(position.y, 160);
      node.position = position;
      const parameters = isPlainObject(node.parameters) ? cloneJson(node.parameters) : {};
      const definition = SHADER_NODE_DEFINITIONS[node.type];
      for (const [parameter, descriptor] of Object.entries(definition?.parameters || {})) {
        if (!hasOwn(parameters, parameter)) defineJsonProperty(parameters, parameter, cloneJson(descriptor.default));
      }
      node.parameters = parameters;
      return node;
    });

    let outputNode = output.nodes.find(node => node.type === 'output');
    if (!outputNode) {
      const id = shaderGeneratedId('output', usedNodeIds, 'output');
      outputNode = { id, type: 'output', position: { x: 520, y: 160 }, parameters: {} };
      output.nodes.push(outputNode);
    }
    output.outputNodeId = typeof source.outputNodeId === 'string' && source.outputNodeId.trim()
      ? source.outputNodeId.trim()
      : outputNode.id;

    const rawLinks = Array.isArray(source.links) ? source.links.filter(isPlainObject) : [];
    if (seededDefault && rawLinks.length === 0) rawLinks.push(...cloneJson(SHADER_GRAPH_DEFAULTS.links));
    const reservedLinkIds = new Set(rawLinks
      .map(link => typeof link.id === 'string' ? link.id.trim() : '')
      .filter(Boolean));
    const usedLinkIds = new Set(reservedLinkIds);
    output.links = rawLinks.map((rawLink, linkIndex) => {
      const link = cloneJson(rawLink);
      const from = isPlainObject(link.from) ? cloneJson(link.from) : {};
      const to = isPlainObject(link.to) ? cloneJson(link.to) : {};
      from.nodeId = typeof from.nodeId === 'string' ? from.nodeId.trim() : '';
      from.port = typeof from.port === 'string' ? from.port.trim() : '';
      to.nodeId = typeof to.nodeId === 'string' ? to.nodeId.trim() : '';
      to.port = typeof to.port === 'string' ? to.port.trim() : '';
      link.from = from;
      link.to = to;
      if (typeof link.id === 'string' && link.id.trim()) link.id = link.id.trim();
      else link.id = shaderGeneratedId(
        `${from.nodeId || 'source'}-${from.port || 'port'}-${to.nodeId || 'target'}-${to.port || 'port'}`,
        usedLinkIds,
        `link-${linkIndex + 1}`
      );
      return link;
    });
    return output;
  }

  function normalizeShaderGraphs(input, options = {}) {
    const source = Array.isArray(input) ? input : [];
    const entries = source.map((graph, index) => ({ graph, index })).filter(entry => isPlainObject(entry.graph));
    const reservedIds = new Set(entries
      .map(entry => typeof entry.graph.id === 'string' ? entry.graph.id.trim() : '')
      .filter(Boolean));
    const usedIds = new Set(reservedIds);
    return entries.map(({ graph: rawGraph, index }) => {
      const graph = normalizeShaderGraph(rawGraph, { ...options, index });
      if (typeof rawGraph.id !== 'string' || !rawGraph.id.trim()) {
        graph.id = shaderGeneratedId(graph.id, usedIds, `shader-graph-${index + 1}`);
      }
      return graph;
    });
  }

  function shaderJsonSafetyDiagnostics(value, pointer) {
    return jsonSafetyDiagnostics(value, pointer).map(item => ({
      ...item,
      code: item.code.replace(/^E_COMPONENT_JSON_/, 'E_SHADER_JSON_'),
      message: item.message.replace(/Component/g, 'Shader Graph').replace(/component/g, 'shader graph')
    }));
  }

  function postProcessJsonSafetyDiagnostics(value, pointer) {
    return jsonSafetyDiagnostics(value, pointer).map(item => ({
      ...item,
      code: item.code === 'E_COMPONENT_JSON_NUMBER'
        ? 'E_POST_PROCESS_NUMBER'
        : item.code.replace(/^E_COMPONENT_JSON_/, 'E_POST_PROCESS_JSON_'),
      message: item.message.replace(/Component/g, 'Post Process').replace(/component/g, 'post process')
    }));
  }

  function shaderValueMatchesDescriptor(value, descriptor, strict) {
    if (descriptor.type === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) return true;
      return !strict && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    }
    return typeof value === descriptor.type;
  }

  function validateShaderGraphDocument(document, options = {}) {
    const output = [];
    const strict = Boolean(options.strict);
    let graphs;
    let basePointer = '/shaderGraphs';
    const projectShapedDocument = isPlainObject(document) && (
      document.format === 'AH2D' || hasOwn(document, 'shaderGraphs') || hasOwn(document, 'currentSceneId') ||
      hasOwn(document, 'postProcess') || Array.isArray(document.scenes) || Array.isArray(document.scene)
    );
    const standaloneGraph = isPlainObject(document) && !projectShapedDocument && (
      hasOwn(document, 'nodes') || hasOwn(document, 'links') || hasOwn(document, 'outputNodeId') ||
      hasOwn(document, 'domain') || (hasOwn(document, 'version') && hasOwn(document, 'id') && hasOwn(document, 'name'))
    );
    const projectDocument = isPlainObject(document) && !standaloneGraph;
    if (Array.isArray(document)) graphs = document;
    else if (standaloneGraph) {
      graphs = [document];
      basePointer = '';
    } else if (isPlainObject(document)) graphs = document.shaderGraphs == null ? [] : document.shaderGraphs;
    else return [diagnostic('E_SHADER_DOCUMENT', 'Shader Graph document must be a plain object or array', '')];
    if (!Array.isArray(graphs)) {
      output.push(diagnostic('E_SHADER_GRAPHS_TYPE', 'shaderGraphs must be an array', basePointer));
      graphs = [];
    }

    const graphIds = new Map();
    graphs.forEach((graph, graphIndex) => {
      const pointer = basePointer ? joinPointer(basePointer, graphIndex) : '';
      if (!isPlainObject(graph)) {
        output.push(diagnostic('E_SHADER_GRAPH_TYPE', 'Shader Graph must be a plain object', pointer));
        return;
      }
      output.push(...shaderJsonSafetyDiagnostics(graph, pointer));
      const graphId = typeof graph.id === 'string' ? graph.id.trim() : '';
      if (!graphId) output.push(diagnostic('E_SHADER_GRAPH_ID', 'Shader Graph id must be a non-empty stable ID', joinPointer(pointer, 'id')));
      else if (graphIds.has(graphId)) output.push(diagnostic('E_SHADER_GRAPH_ID_DUPLICATE', `Duplicate Shader Graph id: ${graphId}`, joinPointer(pointer, 'id'), { firstPointer: graphIds.get(graphId) }));
      else graphIds.set(graphId, joinPointer(pointer, 'id'));
      if (typeof graph.name !== 'string' || !graph.name.trim()) output.push(diagnostic('E_SHADER_GRAPH_NAME', 'Shader Graph name must be a non-empty string', joinPointer(pointer, 'name')));
      const validVersion = graph.version === 1 || (!strict && graph.version === '1');
      if (!validVersion) output.push(diagnostic('E_SHADER_GRAPH_VERSION', 'Shader Graph version must be 1', joinPointer(pointer, 'version'), { expected: 1, actual: graph.version }));
      if (graph.domain !== 'postProcess') output.push(diagnostic('E_SHADER_GRAPH_DOMAIN', 'Shader Graph domain must be postProcess', joinPointer(pointer, 'domain'), { expected: 'postProcess', actual: graph.domain }));

      const nodesPointer = joinPointer(pointer, 'nodes');
      const linksPointer = joinPointer(pointer, 'links');
      if (!Array.isArray(graph.nodes)) {
        output.push(diagnostic('E_SHADER_NODES', 'Shader Graph nodes must be an array', nodesPointer));
        return;
      }
      if (!Array.isArray(graph.links)) {
        output.push(diagnostic('E_SHADER_LINKS', 'Shader Graph links must be an array', linksPointer));
        return;
      }

      const nodesById = new Map();
      const nodePointers = new Map();
      const outputNodes = [];
      graph.nodes.forEach((node, nodeIndex) => {
        const nodePointer = joinPointer(nodesPointer, nodeIndex);
        if (!isPlainObject(node)) {
          output.push(diagnostic('E_SHADER_NODE_TYPE', 'Shader node must be a plain object', nodePointer));
          return;
        }
        const nodeId = typeof node.id === 'string' ? node.id.trim() : '';
        if (!nodeId) output.push(diagnostic('E_SHADER_NODE_ID', 'Shader node id must be a non-empty stable ID', joinPointer(nodePointer, 'id')));
        else if (nodesById.has(nodeId)) output.push(diagnostic('E_SHADER_NODE_ID_DUPLICATE', `Duplicate Shader node id: ${nodeId}`, joinPointer(nodePointer, 'id'), { firstPointer: nodePointers.get(nodeId) }));
        else {
          nodesById.set(nodeId, node);
          nodePointers.set(nodeId, nodePointer);
        }
        const type = typeof node.type === 'string' ? node.type.trim() : '';
        if (!type) output.push(diagnostic('E_SHADER_NODE_KIND', 'Shader node type must be a non-empty string', joinPointer(nodePointer, 'type')));
        else if (!SHADER_NODE_DEFINITIONS[type]) output.push(diagnostic(
          strict ? 'E_SHADER_NODE_UNKNOWN' : 'W_SHADER_NODE_UNKNOWN',
          `Unknown Shader node type is preserved but cannot be validated: ${type}`,
          joinPointer(nodePointer, 'type'),
          { type },
          strict ? 'error' : 'warning'
        ));
        if (type === 'output') outputNodes.push({ id: nodeId, pointer: nodePointer });
        const positionPointer = joinPointer(nodePointer, 'position');
        if (!isPlainObject(node.position)) output.push(diagnostic('E_SHADER_NODE_POSITION', 'Shader node position must be an object', positionPointer));
        else for (const axis of ['x', 'y']) {
          const axisValue = node.position[axis];
          const finite = typeof axisValue === 'number' && Number.isFinite(axisValue);
          const compatible = !strict && typeof axisValue === 'string' && axisValue.trim() !== '' && Number.isFinite(Number(axisValue));
          if (!finite && !compatible) output.push(diagnostic('E_SHADER_NODE_POSITION_VALUE', `Shader node position.${axis} must be finite`, joinPointer(positionPointer, axis), { axis }));
        }
        const parametersPointer = joinPointer(nodePointer, 'parameters');
        if (!isPlainObject(node.parameters)) output.push(diagnostic('E_SHADER_NODE_PARAMETERS', 'Shader node parameters must be an object', parametersPointer));
        else if (SHADER_NODE_DEFINITIONS[type]) {
          for (const [parameter, descriptor] of Object.entries(SHADER_NODE_DEFINITIONS[type].parameters)) {
            if (!hasOwn(node.parameters, parameter)) continue;
            const value = node.parameters[parameter];
            if (!shaderValueMatchesDescriptor(value, descriptor, strict)) {
              output.push(diagnostic('E_SHADER_PARAMETER_TYPE', `${type}.${parameter} must be ${descriptor.type}`, joinPointer(parametersPointer, parameter), { nodeType: type, parameter, expected: descriptor.type }));
              continue;
            }
            if (descriptor.type === 'number') {
              const numeric = Number(value);
              if (descriptor.minimum != null && numeric < descriptor.minimum) output.push(diagnostic('E_SHADER_PARAMETER_RANGE', `${type}.${parameter} must be at least ${descriptor.minimum}`, joinPointer(parametersPointer, parameter), { minimum: descriptor.minimum }));
              if (descriptor.maximum != null && numeric > descriptor.maximum) output.push(diagnostic('E_SHADER_PARAMETER_RANGE', `${type}.${parameter} must be at most ${descriptor.maximum}`, joinPointer(parametersPointer, parameter), { maximum: descriptor.maximum }));
            } else if (descriptor.type === 'string') {
              const parameterPointer = joinPointer(parametersPointer, parameter);
              if (!value.trim()) output.push(diagnostic('E_SHADER_PARAMETER_VALUE', `${type}.${parameter} must be a non-empty string`, parameterPointer));
              else if (descriptor.pattern && !(new RegExp(descriptor.pattern)).test(value)) output.push(diagnostic(
                'E_SHADER_PARAMETER_VALUE',
                `${type}.${parameter} must match ${descriptor.pattern}`,
                parameterPointer,
                { nodeType: type, parameter, pattern: descriptor.pattern }
              ));
            }
          }
        }
      });

      if (outputNodes.length !== 1) output.push(diagnostic('E_SHADER_OUTPUT_COUNT', 'Shader Graph must contain exactly one output node', nodesPointer, { count: outputNodes.length }));
      const outputNodeId = typeof graph.outputNodeId === 'string' ? graph.outputNodeId.trim() : '';
      if (!outputNodeId) output.push(diagnostic('E_SHADER_OUTPUT_ID', 'Shader Graph outputNodeId must be a non-empty node ID', joinPointer(pointer, 'outputNodeId')));
      else if (!nodesById.has(outputNodeId)) output.push(diagnostic('E_SHADER_OUTPUT_REFERENCE', `Shader Graph output node does not exist: ${outputNodeId}`, joinPointer(pointer, 'outputNodeId'), { outputNodeId }));
      else if (nodesById.get(outputNodeId).type !== 'output') output.push(diagnostic('E_SHADER_OUTPUT_KIND', 'Shader Graph outputNodeId must reference an output node', joinPointer(pointer, 'outputNodeId'), { outputNodeId, type: nodesById.get(outputNodeId).type }));
      else if (outputNodes.length === 1 && outputNodes[0].id !== outputNodeId) output.push(diagnostic('E_SHADER_OUTPUT_AMBIGUOUS', 'Shader Graph outputNodeId does not identify its only output node', joinPointer(pointer, 'outputNodeId'), { outputNodeId, expected: outputNodes[0].id }));

      const linkIds = new Map();
      const targetInputs = new Map();
      const incomingInputs = new Set();
      const incomingSources = new Map();
      const adjacency = new Map([...nodesById.keys()].map(id => [id, []]));
      graph.links.forEach((link, linkIndex) => {
        const linkPointer = joinPointer(linksPointer, linkIndex);
        if (!isPlainObject(link)) {
          output.push(diagnostic('E_SHADER_LINK_TYPE', 'Shader link must be a plain object', linkPointer));
          return;
        }
        const linkId = typeof link.id === 'string' ? link.id.trim() : '';
        if (!linkId) output.push(diagnostic('E_SHADER_LINK_ID', 'Shader link id must be a non-empty stable ID', joinPointer(linkPointer, 'id')));
        else if (linkIds.has(linkId)) output.push(diagnostic('E_SHADER_LINK_ID_DUPLICATE', `Duplicate Shader link id: ${linkId}`, joinPointer(linkPointer, 'id'), { firstPointer: linkIds.get(linkId) }));
        else linkIds.set(linkId, joinPointer(linkPointer, 'id'));
        const fromPointer = joinPointer(linkPointer, 'from');
        const toPointer = joinPointer(linkPointer, 'to');
        if (!isPlainObject(link.from)) output.push(diagnostic('E_SHADER_LINK_FROM', 'Shader link from must be an endpoint object', fromPointer));
        if (!isPlainObject(link.to)) output.push(diagnostic('E_SHADER_LINK_TO', 'Shader link to must be an endpoint object', toPointer));
        if (!isPlainObject(link.from) || !isPlainObject(link.to)) return;
        const fromNodeId = typeof link.from.nodeId === 'string' ? link.from.nodeId.trim() : '';
        const fromPort = typeof link.from.port === 'string' ? link.from.port.trim() : '';
        const toNodeId = typeof link.to.nodeId === 'string' ? link.to.nodeId.trim() : '';
        const toPort = typeof link.to.port === 'string' ? link.to.port.trim() : '';
        if (!fromNodeId) output.push(diagnostic('E_SHADER_LINK_NODE_ID', 'Shader link source nodeId must be non-empty', joinPointer(fromPointer, 'nodeId')));
        else if (!nodesById.has(fromNodeId)) output.push(diagnostic('E_SHADER_LINK_NODE_REFERENCE', `Shader link source node does not exist: ${fromNodeId}`, joinPointer(fromPointer, 'nodeId'), { nodeId: fromNodeId }));
        if (!toNodeId) output.push(diagnostic('E_SHADER_LINK_NODE_ID', 'Shader link target nodeId must be non-empty', joinPointer(toPointer, 'nodeId')));
        else if (!nodesById.has(toNodeId)) output.push(diagnostic('E_SHADER_LINK_NODE_REFERENCE', `Shader link target node does not exist: ${toNodeId}`, joinPointer(toPointer, 'nodeId'), { nodeId: toNodeId }));
        if (!fromPort) output.push(diagnostic('E_SHADER_LINK_PORT', 'Shader link source port must be non-empty', joinPointer(fromPointer, 'port')));
        if (!toPort) output.push(diagnostic('E_SHADER_LINK_PORT', 'Shader link target port must be non-empty', joinPointer(toPointer, 'port')));
        const fromDefinition = SHADER_NODE_DEFINITIONS[nodesById.get(fromNodeId)?.type];
        const toDefinition = SHADER_NODE_DEFINITIONS[nodesById.get(toNodeId)?.type];
        const sourceType = fromDefinition?.outputs[fromPort];
        const targetType = toDefinition?.inputs[toPort];
        if (fromDefinition && fromPort && !sourceType) output.push(diagnostic('E_SHADER_LINK_OUTPUT_PORT', `Node ${fromNodeId} has no output port named ${fromPort}`, joinPointer(fromPointer, 'port'), { nodeId: fromNodeId, port: fromPort }));
        if (toDefinition && toPort && !targetType) output.push(diagnostic('E_SHADER_LINK_INPUT_PORT', `Node ${toNodeId} has no input port named ${toPort}`, joinPointer(toPointer, 'port'), { nodeId: toNodeId, port: toPort }));
        if (sourceType && targetType && sourceType !== targetType) output.push(diagnostic('E_SHADER_LINK_VALUE_TYPE', `Cannot connect ${sourceType} to ${targetType}`, linkPointer, { sourceType, targetType }));
        if (toNodeId && toPort) {
          const targetKey = `${toNodeId}\u0000${toPort}`;
          if (targetInputs.has(targetKey)) output.push(diagnostic('E_SHADER_LINK_TARGET_DUPLICATE', `Input ${toNodeId}.${toPort} already has a link`, toPointer, { firstPointer: targetInputs.get(targetKey), nodeId: toNodeId, port: toPort }));
          else targetInputs.set(targetKey, toPointer);
          if (targetType && nodesById.has(fromNodeId) && nodesById.has(toNodeId) && (sourceType || !fromDefinition)) {
            incomingInputs.add(targetKey);
            if (!incomingSources.has(targetKey)) incomingSources.set(targetKey, fromNodeId);
          }
        }
        if (nodesById.has(fromNodeId) && nodesById.has(toNodeId)) adjacency.get(fromNodeId).push({ id: toNodeId, pointer: linkPointer });
      });

      const requiredVisited = new Set();
      const validateRequiredInputs = nodeId => {
        if (!nodeId || requiredVisited.has(nodeId)) return;
        requiredVisited.add(nodeId);
        const node = nodesById.get(nodeId);
        const definition = SHADER_NODE_DEFINITIONS[node?.type];
        if (!definition) return;
        for (const inputPort of Object.keys(definition.inputs)) {
          const targetKey = `${nodeId}\u0000${inputPort}`;
          if (!incomingInputs.has(targetKey)) output.push(diagnostic(
            'E_SHADER_INPUT_REQUIRED',
            `Required input is not connected: ${nodeId}.${inputPort}`,
            joinPointer(nodePointers.get(nodeId) || nodesPointer, 'id'),
            { nodeId, port: inputPort }
          ));
          else validateRequiredInputs(incomingSources.get(targetKey));
        }
      };
      if (nodesById.get(outputNodeId)?.type === 'output') validateRequiredInputs(outputNodeId);

      const visiting = new Set();
      const visited = new Set();
      const stack = [];
      let cycleReported = false;
      const visit = id => {
        if (cycleReported || visited.has(id)) return;
        if (visiting.has(id)) {
          const start = stack.indexOf(id);
          const cycle = [...stack.slice(start), id];
          output.push(diagnostic('E_SHADER_GRAPH_CYCLE', `Shader Graph contains a directed cycle: ${cycle.join(' -> ')}`, linksPointer, { cycle }));
          cycleReported = true;
          return;
        }
        visiting.add(id);
        stack.push(id);
        for (const edge of adjacency.get(id) || []) if (requiredVisited.has(edge.id)) visit(edge.id);
        stack.pop();
        visiting.delete(id);
        visited.add(id);
      };
      for (const id of requiredVisited) visit(id);
    });

    if (projectDocument && hasOwn(document, 'postProcess')) {
      const postProcessPointer = '/postProcess';
      if (!isPlainObject(document.postProcess)) {
        output.push(diagnostic('E_POST_PROCESS_TYPE', 'postProcess must be a plain object', postProcessPointer));
      } else {
        output.push(...postProcessJsonSafetyDiagnostics(document.postProcess, postProcessPointer));
        if (hasOwn(document.postProcess, 'enabled') && typeof document.postProcess.enabled !== 'boolean') {
          output.push(diagnostic('E_POST_PROCESS_ENABLED', 'postProcess.enabled must be boolean', joinPointer(postProcessPointer, 'enabled')));
        }
        const effectsPointer = joinPointer(postProcessPointer, 'effects');
        if (!Array.isArray(document.postProcess.effects)) {
          output.push(diagnostic('E_POST_PROCESS_EFFECTS_TYPE', 'postProcess.effects must be an array', effectsPointer));
          return output;
        }
        const effects = document.postProcess.effects;
        const effectIds = new Map();
        const knownGraphIds = new Set(graphs
          .filter(isPlainObject)
          .map(graph => typeof graph.id === 'string' ? graph.id.trim() : '')
          .filter(Boolean));
        effects.forEach((effect, effectIndex) => {
          const effectPointer = joinPointer(effectsPointer, effectIndex);
          if (!isPlainObject(effect)) {
            output.push(diagnostic('E_POST_PROCESS_EFFECT_OBJECT', 'Post Process effect must be a plain object', effectPointer));
            return;
          }
          const effectIdPointer = joinPointer(effectPointer, 'id');
          const effectId = typeof effect.id === 'string' ? effect.id.trim() : '';
          if (!effectId) output.push(diagnostic('E_POST_PROCESS_EFFECT_ID', 'Post Process effect id must be a non-empty stable ID', effectIdPointer));
          else if (effectIds.has(effectId)) output.push(diagnostic('E_POST_PROCESS_EFFECT_ID_DUPLICATE', `Duplicate Post Process effect id: ${effectId}`, effectIdPointer, { firstPointer: effectIds.get(effectId) }));
          else effectIds.set(effectId, effectIdPointer);
          const effectTypePointer = joinPointer(effectPointer, 'type');
          const effectType = typeof effect.type === 'string' ? effect.type.trim() : '';
          if (!effectType) output.push(diagnostic('E_POST_PROCESS_EFFECT_TYPE', 'Post Process effect type must be a non-empty string', effectTypePointer));
          if (hasOwn(effect, 'name') && typeof effect.name !== 'string') {
            output.push(diagnostic('E_POST_PROCESS_EFFECT_NAME', 'Post Process effect name must be a string', joinPointer(effectPointer, 'name')));
          }
          if (hasOwn(effect, 'enabled') && typeof effect.enabled !== 'boolean') {
            output.push(diagnostic('E_POST_PROCESS_EFFECT_ENABLED', 'Post Process effect enabled must be boolean', joinPointer(effectPointer, 'enabled')));
          }
          if (hasOwn(effect, 'parameters') && !isPlainObject(effect.parameters)) {
            output.push(diagnostic('E_POST_PROCESS_EFFECT_PARAMETERS', 'Post Process effect parameters must be a plain object', joinPointer(effectPointer, 'parameters')));
          }
          const graphPointer = joinPointer(effectPointer, 'graphId');
          const graphId = typeof effect.graphId === 'string' ? effect.graphId.trim() : '';
          if (effectType === 'shaderGraph') {
            if (!graphId) output.push(diagnostic('E_SHADER_EFFECT_GRAPH_ID', 'shaderGraph effect requires a non-empty graphId', graphPointer));
            else if (!knownGraphIds.has(graphId)) output.push(diagnostic('E_SHADER_EFFECT_GRAPH_REFERENCE', `Shader Graph does not exist: ${graphId}`, graphPointer, { graphId }));
          } else if (hasOwn(effect, 'graphId') && !graphId) {
            output.push(diagnostic('E_POST_PROCESS_EFFECT_GRAPH_ID', 'Post Process effect graphId must be a non-empty stable ID when provided', graphPointer));
          }
        });
      }
    }
    return output;
  }

  function assertShaderGraphDocument(document, options = {}) {
    const diagnostics = validateShaderGraphDocument(document, options);
    const errors = diagnostics.filter(item => item.severity === 'error');
    if (errors.length) {
      const first = errors[0];
      throw new ComponentSchemaError(first.code, first.message, { pointer: first.pointer, details: first.details, diagnostics });
    }
    return diagnostics;
  }

  const PARTICLE_ASSET_DEFAULTS = deepFreeze({
    duration: 1,
    loop: true,
    maxParticles: 100,
    emission: { rate: 10, burst: 0 },
    lifetime: { min: 1, max: 1 },
    velocity: { speedMin: 0, speedMax: 0, angle: -90, spread: 0, gravityX: 0, gravityY: 0 },
    shape: { type: 'point', radius: 0, width: 0, height: 0 },
    appearance: { color: '#ffffff', blend: 'normal', baseScale: 1, baseOpacity: 1, baseHue: 0 },
    curves: []
  });
  const PARTICLE_LEGACY_FIELDS = Object.freeze([
    'amount', 'rate', 'lifetime', 'speed', 'spread', 'gravity', 'radius', 'scale', 'opacity', 'hue', 'blend', 'playing'
  ]);
  const PARTICLE_EMITTER_LEGACY_FIELDS = Object.freeze([
    'name', 'amount', 'rate', 'lifetime', 'speed', 'spread', 'gravity', 'radius', 'scale', 'opacity', 'hue', 'blend'
  ]);
  function particleSlug(value, fallback = 'particle') {
    const slug = String(value == null ? '' : value)
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || fallback;
  }

  function particleGeneratedId(base, used, fallback) {
    const stem = particleSlug(base, fallback);
    let candidate = stem;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${stem}-${suffix++}`;
    used.add(candidate);
    return candidate;
  }

  function particleNumber(value, fallback, options = {}) {
    let result = Number(value);
    if (!Number.isFinite(result)) result = fallback;
    if (options.integer) result = Math.floor(result);
    if (options.minimum != null) result = Math.max(options.minimum, result);
    if (options.maximum != null) result = Math.min(options.maximum, result);
    return result;
  }

  function particleRange(minimum, maximum, fallbackMinimum, fallbackMaximum, options = {}) {
    let min = particleNumber(minimum, fallbackMinimum, options);
    let max = particleNumber(maximum, fallbackMaximum, options);
    if (min > max) [min, max] = [max, min];
    return { min, max };
  }

  function normalizeParticleCurve(input, options = {}) {
    const source = isPlainObject(input) ? cloneJson(input) : {};
    const output = source;
    const index = Number.isInteger(options.index) && options.index >= 0 ? options.index : 0;
    const usedCurveIds = options.usedCurveIds instanceof Set ? options.usedCurveIds : new Set();
    const propertySource = source.property ?? source.channel ?? source.type;
    const authoredProperty = typeof propertySource === 'string' && propertySource.trim()
      ? propertySource.trim().toLowerCase()
      : PARTICLE_CURVE_PROPERTIES[index % PARTICLE_CURVE_PROPERTIES.length];
    output.property = authoredProperty;
    if (typeof source.id === 'string' && source.id.trim()) {
      output.id = source.id.trim();
      usedCurveIds.add(output.id);
    } else output.id = particleGeneratedId(authoredProperty, usedCurveIds, `curve-${index + 1}`);
    const authoredInterpolation = typeof source.interpolation === 'string' && source.interpolation.trim()
      ? source.interpolation.trim().toLowerCase()
      : 'linear';
    output.interpolation = authoredInterpolation;
    const rawKeys = Array.isArray(source.keys)
      ? source.keys
      : (Array.isArray(source.keyframes) ? source.keyframes : []);
    const keyEntries = rawKeys.filter(isPlainObject);
    const reservedKeyIds = new Set(keyEntries
      .map(key => typeof key.id === 'string' ? key.id.trim() : '')
      .filter(Boolean));
    const usedKeyIds = new Set(reservedKeyIds);
    output.keys = keyEntries.map((rawKey, keyIndex) => {
      const key = cloneJson(rawKey);
      const defaultTime = keyEntries.length > 1 ? keyIndex / (keyEntries.length - 1) : 0;
      key.time = particleNumber(key.time, defaultTime, { minimum: 0, maximum: 1 });
      key.value = particleNumber(key.value, 0);
      if (hasOwn(key, 'inTangent')) key.inTangent = particleNumber(key.inTangent, 0);
      if (hasOwn(key, 'outTangent')) key.outTangent = particleNumber(key.outTangent, 0);
      if (typeof key.id === 'string' && key.id.trim()) key.id = key.id.trim();
      else key.id = particleGeneratedId(`${output.id}-${key.time}`, usedKeyIds, `key-${keyIndex + 1}`);
      return key;
    }).sort((left, right) => left.time - right.time);
    return output;
  }

  function normalizeParticleAsset(input, options = {}) {
    if (Number.isInteger(options)) options = { index: options };
    const source = isPlainObject(input) ? cloneJson(input) : {};
    const output = source;
    const index = Number.isInteger(options.index) && options.index >= 0 ? options.index : 0;
    const name = typeof source.name === 'string' && source.name.trim()
      ? source.name.trim()
      : (typeof source.id === 'string' && source.id.trim() ? source.id.trim() : `Particle ${index + 1}`);
    output.id = typeof source.id === 'string' && source.id.trim()
      ? source.id.trim()
      : particleSlug(name, `particle-${index + 1}`);
    output.name = name;
    output.duration = Number.isFinite(Number(source.duration)) && Number(source.duration) > 0
      ? Number(source.duration)
      : PARTICLE_ASSET_DEFAULTS.duration;
    output.loop = typeof source.loop === 'boolean' ? source.loop : PARTICLE_ASSET_DEFAULTS.loop;
    output.maxParticles = particleNumber(source.maxParticles ?? source.amount, PARTICLE_ASSET_DEFAULTS.maxParticles, { integer: true, minimum: 0 });

    const emissionSource = isPlainObject(source.emission) ? cloneJson(source.emission) : {};
    emissionSource.rate = particleNumber(emissionSource.rate ?? source.rate, PARTICLE_ASSET_DEFAULTS.emission.rate, { minimum: 0 });
    emissionSource.burst = particleNumber(emissionSource.burst, PARTICLE_ASSET_DEFAULTS.emission.burst, { integer: true, minimum: 0 });
    output.emission = emissionSource;

    const lifetimeSource = isPlainObject(source.lifetime) ? cloneJson(source.lifetime) : {};
    const legacyLifetime = !isPlainObject(source.lifetime) ? source.lifetime : undefined;
    const lifetime = particleRange(
      lifetimeSource.min ?? legacyLifetime,
      lifetimeSource.max ?? legacyLifetime,
      PARTICLE_ASSET_DEFAULTS.lifetime.min,
      PARTICLE_ASSET_DEFAULTS.lifetime.max,
      { minimum: 0 }
    );
    lifetimeSource.min = lifetime.min;
    lifetimeSource.max = lifetime.max;
    output.lifetime = lifetimeSource;

    const velocitySource = isPlainObject(source.velocity) ? cloneJson(source.velocity) : {};
    const speed = particleRange(
      velocitySource.speedMin ?? source.speed,
      velocitySource.speedMax ?? source.speed,
      PARTICLE_ASSET_DEFAULTS.velocity.speedMin,
      PARTICLE_ASSET_DEFAULTS.velocity.speedMax,
      { minimum: 0 }
    );
    velocitySource.speedMin = speed.min;
    velocitySource.speedMax = speed.max;
    velocitySource.angle = particleNumber(velocitySource.angle, PARTICLE_ASSET_DEFAULTS.velocity.angle);
    velocitySource.spread = particleNumber(velocitySource.spread ?? source.spread, PARTICLE_ASSET_DEFAULTS.velocity.spread, { minimum: 0 });
    velocitySource.gravityX = particleNumber(velocitySource.gravityX, PARTICLE_ASSET_DEFAULTS.velocity.gravityX);
    velocitySource.gravityY = particleNumber(velocitySource.gravityY ?? source.gravity, PARTICLE_ASSET_DEFAULTS.velocity.gravityY);
    output.velocity = velocitySource;

    const shapeSource = isPlainObject(source.shape) ? cloneJson(source.shape) : {};
    const defaultShape = source.radius != null ? 'circle' : PARTICLE_ASSET_DEFAULTS.shape.type;
    shapeSource.type = typeof shapeSource.type === 'string' && shapeSource.type.trim()
      ? shapeSource.type.trim().toLowerCase()
      : defaultShape;
    shapeSource.radius = particleNumber(shapeSource.radius ?? source.radius, PARTICLE_ASSET_DEFAULTS.shape.radius, { minimum: 0 });
    shapeSource.width = particleNumber(shapeSource.width, PARTICLE_ASSET_DEFAULTS.shape.width, { minimum: 0 });
    shapeSource.height = particleNumber(shapeSource.height, PARTICLE_ASSET_DEFAULTS.shape.height, { minimum: 0 });
    output.shape = shapeSource;

    const appearanceSource = isPlainObject(source.appearance) ? cloneJson(source.appearance) : {};
    if (hasOwn(appearanceSource, 'assetId')) {
      appearanceSource.assetId = typeof appearanceSource.assetId === 'string' && appearanceSource.assetId.trim()
        ? appearanceSource.assetId.trim()
        : null;
    }
    appearanceSource.color = typeof (appearanceSource.color ?? source.color) === 'string' && String(appearanceSource.color ?? source.color).trim()
      ? String(appearanceSource.color ?? source.color).trim()
      : PARTICLE_ASSET_DEFAULTS.appearance.color;
    const blend = String(appearanceSource.blend ?? source.blend ?? PARTICLE_ASSET_DEFAULTS.appearance.blend).trim().toLowerCase();
    appearanceSource.blend = blend === 'add' ? 'additive' : blend;
    appearanceSource.baseScale = particleNumber(appearanceSource.baseScale ?? source.scale, PARTICLE_ASSET_DEFAULTS.appearance.baseScale, { minimum: 0 });
    appearanceSource.baseOpacity = particleNumber(appearanceSource.baseOpacity ?? source.opacity, PARTICLE_ASSET_DEFAULTS.appearance.baseOpacity, { minimum: 0, maximum: 1 });
    appearanceSource.baseHue = particleNumber(appearanceSource.baseHue ?? source.hue, PARTICLE_ASSET_DEFAULTS.appearance.baseHue);
    output.appearance = appearanceSource;

    const rawCurves = Array.isArray(source.curves) ? source.curves : [];
    const curveEntries = rawCurves.filter(isPlainObject);
    const reservedCurveIds = new Set(curveEntries
      .map(curve => typeof curve.id === 'string' ? curve.id.trim() : '')
      .filter(Boolean));
    const usedCurveIds = new Set(reservedCurveIds);
    output.curves = curveEntries.map((curve, curveIndex) => normalizeParticleCurve(curve, { index: curveIndex, usedCurveIds }));
    return output;
  }

  function normalizeParticleAssets(input, options = {}) {
    const source = Array.isArray(input) ? input : [];
    const entries = source.map((asset, index) => ({ asset, index })).filter(entry => isPlainObject(entry.asset));
    const reservedIds = new Set(entries
      .map(entry => typeof entry.asset.id === 'string' ? entry.asset.id.trim() : '')
      .filter(Boolean));
    const usedIds = new Set(reservedIds);
    return entries.map(({ asset: rawAsset, index }) => {
      const asset = normalizeParticleAsset(rawAsset, { ...options, index });
      if (typeof rawAsset.id !== 'string' || !rawAsset.id.trim()) {
        asset.id = particleGeneratedId(asset.id, usedIds, `particle-${index + 1}`);
      }
      return asset;
    });
  }

  function sampleParticleCurve(curve, time = 0, options = {}) {
    const fallback = Number.isFinite(Number(options.defaultValue)) ? Number(options.defaultValue) : 0;
    if (!isPlainObject(curve) || !Array.isArray(curve.keys)) return fallback;
    const keys = curve.keys
      .filter(key => isPlainObject(key) && Number.isFinite(Number(key.time)) && Number.isFinite(Number(key.value)))
      .map(key => ({ ...key, time: Number(key.time), value: Number(key.value) }))
      .sort((left, right) => left.time - right.time);
    if (!keys.length) return fallback;
    const requested = Number.isFinite(Number(time)) ? Number(time) : 0;
    const sampleTime = Math.max(0, Math.min(1, requested));
    if (sampleTime <= keys[0].time) return keys[0].value;
    if (sampleTime >= keys[keys.length - 1].time) return keys[keys.length - 1].value;
    const exact = keys.find(key => Math.abs(key.time - sampleTime) <= 1e-12);
    if (exact) return exact.value;
    let left = keys[0];
    let right = keys[keys.length - 1];
    for (let index = 1; index < keys.length; index += 1) {
      if (keys[index].time >= sampleTime) {
        left = keys[index - 1];
        right = keys[index];
        break;
      }
    }
    const span = right.time - left.time;
    if (!(span > 0)) return right.value;
    const amount = (sampleTime - left.time) / span;
    const interpolation = String(curve.interpolation || 'linear').trim().toLowerCase();
    if (interpolation === 'step') return left.value;
    if (interpolation !== 'cubic') return left.value + (right.value - left.value) * amount;
    const slope = (right.value - left.value) / span;
    const outTangent = Number.isFinite(Number(left.outTangent)) ? Number(left.outTangent) : slope;
    const inTangent = Number.isFinite(Number(right.inTangent)) ? Number(right.inTangent) : slope;
    const t2 = amount * amount;
    const t3 = t2 * amount;
    const h00 = (2 * t3) - (3 * t2) + 1;
    const h10 = t3 - (2 * t2) + amount;
    const h01 = (-2 * t3) + (3 * t2);
    const h11 = t3 - t2;
    return (h00 * left.value) + (h10 * span * outTangent) + (h01 * right.value) + (h11 * span * inTangent);
  }

  function particleLegacyDiagnostic(output, strict, message, pointer, details) {
    output.push(diagnostic(
      strict ? 'E_PARTICLE_ASSET_LEGACY' : 'W_PARTICLE_ASSET_LEGACY',
      message,
      pointer,
      details,
      strict ? 'error' : 'warning'
    ));
  }

  function particleFiniteNumber(value, strict) {
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    return !strict && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
  }

  function particleInteger(value, strict) {
    if (Number.isInteger(value)) return true;
    return !strict && typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value));
  }

  function particleHasCanonicalAssetFields(asset) {
    if (!isPlainObject(asset)) return false;
    return ['duration', 'maxParticles', 'emission', 'velocity', 'shape', 'appearance', 'curves'].some(field => hasOwn(asset, field)) ||
      isPlainObject(asset.lifetime);
  }

  function particleLegacyAsset(asset) {
    if (!isPlainObject(asset)) return false;
    return !particleHasCanonicalAssetFields(asset) && PARTICLE_LEGACY_FIELDS.some(field => hasOwn(asset, field));
  }

  function particleEntityCollections(document) {
    if (!isPlainObject(document) || document.format === 'AH2D.Particle') return [];
    const collections = [];
    if (Array.isArray(document.scenes) && document.scenes.length) {
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

  function validateParticleEmitterReferences(document, particleIds, particleAssets, output, options = {}) {
    const strict = Boolean(options.strict);
    const codec = options.entityCodec instanceof EntityCodec ? options.entityCodec : createDefaultEntityCodec();
    for (const collection of particleEntityCollections(document)) {
      collection.entities.forEach((entity, entityIndex) => {
        if (!isPlainObject(entity)) return;
        let resolved;
        try { resolved = codec.resolve(entity, 'ParticleEmitter'); }
        catch (_) { return; }
        if (!resolved.found || !isPlainObject(resolved.value)) return;
        const emitter = resolved.value;
        const pointer = `${collection.pointer}/${entityIndex}${pointerForStorage(resolved.storage)}`;
        const assetId = typeof emitter.assetId === 'string' ? emitter.assetId.trim() : '';
        if (!assetId) {
          const legacyFields = PARTICLE_EMITTER_LEGACY_FIELDS.filter(field => hasOwn(emitter, field));
          if (legacyFields.length) {
            output.push(diagnostic(
              strict ? 'E_PARTICLE_EMITTER_LEGACY' : 'W_PARTICLE_EMITTER_LEGACY',
              'Legacy inline ParticleEmitter configuration should be moved to a Particle Asset and referenced by assetId',
              pointer,
              { fields: legacyFields },
              strict ? 'error' : 'warning'
            ));
          } else {
            output.push(diagnostic(
              'E_PARTICLE_EMITTER_ASSET',
              'ParticleEmitter.assetId must reference a Particle Asset',
              joinPointer(pointer, 'assetId')
            ));
          }
        } else if (!particleIds.has(assetId)) {
          output.push(diagnostic(
            'E_PARTICLE_ASSET_REFERENCE',
            `Particle Asset does not exist: ${assetId}`,
            joinPointer(pointer, 'assetId'),
            { assetId }
          ));
        } else if (isPlainObject(emitter.overrides) && Object.keys(emitter.overrides).length) {
          const overridesPointer = joinPointer(pointer, 'overrides');
          for (const identityField of ['id', 'name']) {
            if (hasOwn(emitter.overrides, identityField)) {
              output.push(diagnostic(
                'E_PARTICLE_OVERRIDE_IDENTITY',
                `ParticleEmitter overrides cannot replace Particle Asset ${identityField}`,
                joinPointer(overridesPointer, identityField),
                { assetId, field: identityField }
              ));
            }
          }
          const sourceAsset = particleAssets.get(assetId);
          if (sourceAsset) {
            const effectiveAsset = deepMerge(sourceAsset, emitter.overrides);
            effectiveAsset.id = sourceAsset.id;
            effectiveAsset.name = sourceAsset.name;
            const overrideDiagnostics = validateParticleDocument([effectiveAsset], {
              strict,
              entityCodec: codec
            });
            for (const item of overrideDiagnostics) {
              const suffix = String(item.pointer || '').replace(/^\/particles\/0/, '');
              const topLevelField = suffix.split('/')[1] || '';
              if (!topLevelField || !hasOwn(emitter.overrides, topLevelField)) continue;
              output.push({
                ...item,
                pointer: `${overridesPointer}${suffix}`,
                details: { ...(item.details || {}), assetId }
              });
            }
          }
        }
      });
    }
  }

  function validateParticleDocument(document, options = {}) {
    const output = [];
    const strict = Boolean(options.strict);
    const standaloneParticle = isPlainObject(document) && document.format === 'AH2D.Particle';
    const projectShapedDocument = isPlainObject(document) && (
      document.format === 'AH2D' || hasOwn(document, 'particles') || hasOwn(document, 'currentSceneId') ||
      Array.isArray(document.scenes) || Array.isArray(document.scene) || Array.isArray(document.entities)
    );
    const declaredParticleDialect = isPlainObject(document) && typeof document.format === 'string' &&
      document.format.trim().toLowerCase().startsWith('ah2d.particle');
    const standaloneParticleCandidate = standaloneParticle || (isPlainObject(document) && !projectShapedDocument && (
      declaredParticleDialect || particleLegacyAsset(document) ||
      (particleHasCanonicalAssetFields(document) && (hasOwn(document, 'id') || hasOwn(document, 'name')))
    ));
    if (standaloneParticleCandidate && !standaloneParticle) {
      output.push(diagnostic(
        'E_PARTICLE_DOCUMENT_FORMAT',
        'Standalone Particle Asset format must be AH2D.Particle',
        '/format',
        { expected: 'AH2D.Particle', actual: document.format ?? null }
      ));
    }
    if (standaloneParticleCandidate && (!particleInteger(document.version, strict) || Number(document.version) !== 1)) {
      output.push(diagnostic(
        'E_PARTICLE_DOCUMENT_VERSION',
        'AH2D.Particle version must be 1',
        '/version',
        { expected: 1, actual: document.version }
      ));
    }
    const definitionFreeEcsSnapshot = isPlainObject(document) &&
      Number(document.version) === 3 && Array.isArray(document.entities) && document.particles == null;
    let particles;
    let basePointer = '/particles';
    if (Array.isArray(document)) particles = document;
    else if (standaloneParticleCandidate) { particles = [document]; basePointer = ''; }
    else if (isPlainObject(document)) particles = document.particles == null ? [] : document.particles;
    else return [diagnostic('E_PARTICLE_DOCUMENT', 'Particle document must be a plain object or array', '')];
    if (!Array.isArray(particles)) return [diagnostic('E_PARTICLES_TYPE', 'particles must be an array', basePointer)];

    const particleIds = new Map();
    const particleAssets = new Map();
    particles.forEach((asset, assetIndex) => {
      const pointer = basePointer ? joinPointer(basePointer, assetIndex) : '';
      if (!isPlainObject(asset)) {
        output.push(diagnostic('E_PARTICLE_ASSET_TYPE', 'Particle Asset must be a plain object', pointer));
        return;
      }
      output.push(...jsonSafetyDiagnostics(asset, pointer));
      const legacyAsset = particleLegacyAsset(asset) ||
        (asset.format === 'AH2D.Particle' && !particleHasCanonicalAssetFields(asset));
      const id = typeof asset.id === 'string' ? asset.id.trim() : '';
      if (!id) {
        if (legacyAsset) particleLegacyDiagnostic(output, strict, 'Particle Asset has no stable id', joinPointer(pointer, 'id'));
        else output.push(diagnostic('E_PARTICLE_ASSET_ID', 'Particle Asset id must be a non-empty stable ID', joinPointer(pointer, 'id')));
      }
      else if (particleIds.has(id)) output.push(diagnostic(
        'E_PARTICLE_ASSET_ID_DUPLICATE',
        `Duplicate Particle Asset id: ${id}`,
        joinPointer(pointer, 'id'),
        { firstPointer: particleIds.get(id) }
      ));
      else {
        particleIds.set(id, joinPointer(pointer, 'id'));
        particleAssets.set(id, asset);
      }

      const name = typeof asset.name === 'string' ? asset.name.trim() : '';
      if (!name) output.push(diagnostic('E_PARTICLE_ASSET_NAME', 'Particle Asset name must be a non-empty string', joinPointer(pointer, 'name')));

      if (legacyAsset) {
        particleLegacyDiagnostic(output, strict, 'Legacy flat Particle configuration must be normalized to the Particle Asset v1 contract', pointer);
        const numericFields = [
          ['rate', 0, null], ['lifetime', 0, null], ['speed', null, null], ['spread', 0, null], ['gravity', null, null],
          ['radius', 0, null], ['scale', 0, null], ['opacity', 0, 1], ['hue', null, null]
        ];
        if (hasOwn(asset, 'amount') && (!particleInteger(asset.amount, strict) || Number(asset.amount) < 0)) {
          output.push(diagnostic('E_PARTICLE_MAX_PARTICLES', 'Legacy amount must be a non-negative integer', joinPointer(pointer, 'amount')));
        }
        for (const [field, minimum, maximum] of numericFields) {
          if (!hasOwn(asset, field)) continue;
          const value = Number(asset[field]);
          if (!particleFiniteNumber(asset[field], strict) || (minimum != null && value < minimum) || (maximum != null && value > maximum)) {
            output.push(diagnostic('E_PARTICLE_LEGACY_VALUE', `Legacy ${field} is outside its supported numeric range`, joinPointer(pointer, field), { field }));
          }
        }
        if (hasOwn(asset, 'loop') && typeof asset.loop !== 'boolean') output.push(diagnostic('E_PARTICLE_LOOP', 'Particle loop must be boolean', joinPointer(pointer, 'loop')));
        if (hasOwn(asset, 'playing') && typeof asset.playing !== 'boolean') output.push(diagnostic('E_PARTICLE_PLAYING', 'Legacy playing must be boolean', joinPointer(pointer, 'playing')));
        if (hasOwn(asset, 'blend') && (typeof asset.blend !== 'string' || !['normal', 'additive', 'add'].includes(asset.blend.trim().toLowerCase()))) {
          output.push(diagnostic('E_PARTICLE_BLEND', 'Legacy blend must be Normal or Additive', joinPointer(pointer, 'blend')));
        }
        return;
      }

      if (!particleFiniteNumber(asset.duration, strict) || Number(asset.duration) <= 0) output.push(diagnostic('E_PARTICLE_DURATION', 'Particle Asset duration must be greater than zero', joinPointer(pointer, 'duration')));
      if (typeof asset.loop !== 'boolean') output.push(diagnostic('E_PARTICLE_LOOP', 'Particle Asset loop must be boolean', joinPointer(pointer, 'loop')));
      if (!particleInteger(asset.maxParticles, strict) || Number(asset.maxParticles) < 0) output.push(diagnostic('E_PARTICLE_MAX_PARTICLES', 'Particle Asset maxParticles must be a non-negative integer', joinPointer(pointer, 'maxParticles')));

      const emissionPointer = joinPointer(pointer, 'emission');
      if (!isPlainObject(asset.emission)) output.push(diagnostic('E_PARTICLE_EMISSION', 'Particle Asset emission must be an object', emissionPointer));
      else {
        if (!particleFiniteNumber(asset.emission.rate, strict) || Number(asset.emission.rate) < 0) output.push(diagnostic('E_PARTICLE_EMISSION_RATE', 'Emission rate must be a non-negative number', joinPointer(emissionPointer, 'rate')));
        if (!particleInteger(asset.emission.burst, strict) || Number(asset.emission.burst) < 0) output.push(diagnostic('E_PARTICLE_EMISSION_BURST', 'Emission burst must be a non-negative integer', joinPointer(emissionPointer, 'burst')));
      }

      const lifetimePointer = joinPointer(pointer, 'lifetime');
      if (!isPlainObject(asset.lifetime)) output.push(diagnostic('E_PARTICLE_LIFETIME', 'Particle Asset lifetime must be an object', lifetimePointer));
      else {
        const minValid = particleFiniteNumber(asset.lifetime.min, strict) && Number(asset.lifetime.min) >= 0;
        const maxValid = particleFiniteNumber(asset.lifetime.max, strict) && Number(asset.lifetime.max) >= 0;
        if (!minValid) output.push(diagnostic('E_PARTICLE_LIFETIME_MIN', 'Lifetime min must be a non-negative number', joinPointer(lifetimePointer, 'min')));
        if (!maxValid) output.push(diagnostic('E_PARTICLE_LIFETIME_MAX', 'Lifetime max must be a non-negative number', joinPointer(lifetimePointer, 'max')));
        if (minValid && maxValid && Number(asset.lifetime.min) > Number(asset.lifetime.max)) output.push(diagnostic('E_PARTICLE_LIFETIME_RANGE', 'Lifetime min must not exceed max', lifetimePointer));
      }

      const velocityPointer = joinPointer(pointer, 'velocity');
      if (!isPlainObject(asset.velocity)) output.push(diagnostic('E_PARTICLE_VELOCITY', 'Particle Asset velocity must be an object', velocityPointer));
      else {
        const speedMinValid = particleFiniteNumber(asset.velocity.speedMin, strict) && Number(asset.velocity.speedMin) >= 0;
        const speedMaxValid = particleFiniteNumber(asset.velocity.speedMax, strict) && Number(asset.velocity.speedMax) >= 0;
        if (!speedMinValid) output.push(diagnostic('E_PARTICLE_SPEED_MIN', 'Velocity speedMin must be a non-negative number', joinPointer(velocityPointer, 'speedMin')));
        if (!speedMaxValid) output.push(diagnostic('E_PARTICLE_SPEED_MAX', 'Velocity speedMax must be a non-negative number', joinPointer(velocityPointer, 'speedMax')));
        if (speedMinValid && speedMaxValid && Number(asset.velocity.speedMin) > Number(asset.velocity.speedMax)) output.push(diagnostic('E_PARTICLE_SPEED_RANGE', 'Velocity speedMin must not exceed speedMax', velocityPointer));
        for (const field of ['angle', 'gravityX', 'gravityY']) {
          if (!particleFiniteNumber(asset.velocity[field], strict)) output.push(diagnostic('E_PARTICLE_VELOCITY_VALUE', `Velocity ${field} must be a finite number`, joinPointer(velocityPointer, field), { field }));
        }
        if (!particleFiniteNumber(asset.velocity.spread, strict) || Number(asset.velocity.spread) < 0) output.push(diagnostic('E_PARTICLE_SPREAD', 'Velocity spread must be a non-negative number', joinPointer(velocityPointer, 'spread')));
      }

      const shapePointer = joinPointer(pointer, 'shape');
      if (!isPlainObject(asset.shape)) output.push(diagnostic('E_PARTICLE_SHAPE', 'Particle Asset shape must be an object', shapePointer));
      else {
        if (!['point', 'circle', 'box'].includes(asset.shape.type)) output.push(diagnostic('E_PARTICLE_SHAPE_TYPE', 'Particle shape type must be point, circle, or box', joinPointer(shapePointer, 'type')));
        for (const field of ['radius', 'width', 'height']) {
          if (!particleFiniteNumber(asset.shape[field], strict) || Number(asset.shape[field]) < 0) output.push(diagnostic('E_PARTICLE_SHAPE_SIZE', `Particle shape ${field} must be a non-negative number`, joinPointer(shapePointer, field), { field }));
        }
      }

      const appearancePointer = joinPointer(pointer, 'appearance');
      if (!isPlainObject(asset.appearance)) output.push(diagnostic('E_PARTICLE_APPEARANCE', 'Particle Asset appearance must be an object', appearancePointer));
      else {
        if (asset.appearance.assetId != null && (typeof asset.appearance.assetId !== 'string' || !asset.appearance.assetId.trim())) output.push(diagnostic('E_PARTICLE_APPEARANCE_ASSET', 'Appearance assetId must be null or a non-empty string', joinPointer(appearancePointer, 'assetId')));
        if (typeof asset.appearance.color !== 'string' || !asset.appearance.color.trim()) output.push(diagnostic('E_PARTICLE_COLOR', 'Appearance color must be a non-empty string', joinPointer(appearancePointer, 'color')));
        if (!['normal', 'additive'].includes(asset.appearance.blend)) output.push(diagnostic('E_PARTICLE_BLEND', 'Appearance blend must be normal or additive', joinPointer(appearancePointer, 'blend')));
        if (!particleFiniteNumber(asset.appearance.baseScale, strict) || Number(asset.appearance.baseScale) < 0) output.push(diagnostic('E_PARTICLE_BASE_SCALE', 'Appearance baseScale must be a non-negative number', joinPointer(appearancePointer, 'baseScale')));
        if (!particleFiniteNumber(asset.appearance.baseOpacity, strict) || Number(asset.appearance.baseOpacity) < 0 || Number(asset.appearance.baseOpacity) > 1) output.push(diagnostic('E_PARTICLE_BASE_OPACITY', 'Appearance baseOpacity must be between zero and one', joinPointer(appearancePointer, 'baseOpacity')));
        if (!particleFiniteNumber(asset.appearance.baseHue, strict)) output.push(diagnostic('E_PARTICLE_BASE_HUE', 'Appearance baseHue must be a finite number', joinPointer(appearancePointer, 'baseHue')));
      }

      const curvesPointer = joinPointer(pointer, 'curves');
      if (!Array.isArray(asset.curves)) output.push(diagnostic('E_PARTICLE_CURVES', 'Particle Asset curves must be an array', curvesPointer));
      else {
        const curveIds = new Map();
        const curveProperties = new Map();
        asset.curves.forEach((curve, curveIndex) => {
          const curvePointer = joinPointer(curvesPointer, curveIndex);
          if (!isPlainObject(curve)) { output.push(diagnostic('E_PARTICLE_CURVE_TYPE', 'Particle curve must be a plain object', curvePointer)); return; }
          const curveId = typeof curve.id === 'string' ? curve.id.trim() : '';
          if (!curveId) output.push(diagnostic('E_PARTICLE_CURVE_ID', 'Particle curve id must be a non-empty string', joinPointer(curvePointer, 'id')));
          else if (curveIds.has(curveId)) output.push(diagnostic('E_PARTICLE_CURVE_ID_DUPLICATE', `Duplicate Particle curve id: ${curveId}`, joinPointer(curvePointer, 'id'), { firstPointer: curveIds.get(curveId) }));
          else curveIds.set(curveId, joinPointer(curvePointer, 'id'));
          if (!PARTICLE_CURVE_PROPERTIES.includes(curve.property)) output.push(diagnostic('E_PARTICLE_CURVE_PROPERTY', `Particle curve property must be one of: ${PARTICLE_CURVE_PROPERTIES.join(', ')}`, joinPointer(curvePointer, 'property')));
          else if (curveProperties.has(curve.property)) output.push(diagnostic('E_PARTICLE_CURVE_PROPERTY_DUPLICATE', `Particle Asset already has a ${curve.property} curve`, joinPointer(curvePointer, 'property'), { firstPointer: curveProperties.get(curve.property) }));
          else curveProperties.set(curve.property, joinPointer(curvePointer, 'property'));
          if (!PARTICLE_CURVE_INTERPOLATIONS.includes(curve.interpolation)) output.push(diagnostic('E_PARTICLE_CURVE_INTERPOLATION', 'Particle curve interpolation must be linear, step, or cubic', joinPointer(curvePointer, 'interpolation')));
          const keysPointer = joinPointer(curvePointer, 'keys');
          if (!Array.isArray(curve.keys)) { output.push(diagnostic('E_PARTICLE_CURVE_KEYS', 'Particle curve keys must be an array', keysPointer)); return; }
          const keyIds = new Map();
          const keyTimes = new Map();
          let previousTime = -Infinity;
          curve.keys.forEach((key, keyIndex) => {
            const keyPointer = joinPointer(keysPointer, keyIndex);
            if (!isPlainObject(key)) { output.push(diagnostic('E_PARTICLE_CURVE_KEY_TYPE', 'Particle curve key must be a plain object', keyPointer)); return; }
            const keyId = typeof key.id === 'string' ? key.id.trim() : '';
            if (!keyId) output.push(diagnostic('E_PARTICLE_CURVE_KEY_ID', 'Particle curve key id must be a non-empty string', joinPointer(keyPointer, 'id')));
            else if (keyIds.has(keyId)) output.push(diagnostic('E_PARTICLE_CURVE_KEY_ID_DUPLICATE', `Duplicate Particle curve key id: ${keyId}`, joinPointer(keyPointer, 'id'), { firstPointer: keyIds.get(keyId) }));
            else keyIds.set(keyId, joinPointer(keyPointer, 'id'));
            const timeValid = particleFiniteNumber(key.time, strict) && Number(key.time) >= 0 && Number(key.time) <= 1;
            const keyTime = Number(key.time);
            if (!timeValid) output.push(diagnostic('E_PARTICLE_CURVE_KEY_TIME', 'Particle curve key time must be between zero and one', joinPointer(keyPointer, 'time')));
            else {
              if (keyTimes.has(keyTime)) output.push(diagnostic('E_PARTICLE_CURVE_KEY_TIME_DUPLICATE', `Particle curve already has a key at time ${keyTime}`, joinPointer(keyPointer, 'time'), { firstPointer: keyTimes.get(keyTime) }));
              else keyTimes.set(keyTime, joinPointer(keyPointer, 'time'));
              if (keyTime < previousTime) output.push(diagnostic('E_PARTICLE_CURVE_KEY_ORDER', 'Particle curve keys must be sorted by ascending time', joinPointer(keyPointer, 'time')));
              previousTime = keyTime;
            }
            if (!particleFiniteNumber(key.value, strict)) output.push(diagnostic('E_PARTICLE_CURVE_KEY_VALUE', 'Particle curve key value must be a finite number', joinPointer(keyPointer, 'value')));
            for (const tangent of ['inTangent', 'outTangent']) {
              if (hasOwn(key, tangent) && !particleFiniteNumber(key[tangent], strict)) output.push(diagnostic('E_PARTICLE_CURVE_KEY_TANGENT', `${tangent} must be a finite number`, joinPointer(keyPointer, tangent), { tangent }));
            }
          });
        });
      }
    });

    if (!definitionFreeEcsSnapshot) validateParticleEmitterReferences(document, particleIds, particleAssets, output, options);
    return output;
  }

  function assertParticleDocument(document, options = {}) {
    const diagnostics = validateParticleDocument(document, options);
    const errors = diagnostics.filter(item => item.severity === 'error');
    if (errors.length) {
      const first = errors[0];
      throw new ComponentSchemaError(first.code, first.message, { pointer: first.pointer, details: first.details, diagnostics });
    }
    return diagnostics;
  }

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
    {
      type: 'ParticleEmitter', schemas: COMPONENT_SCHEMAS.ParticleEmitter,
      defaults: { autoplay: true, time: 0, speed: 1, emitting: true, overrides: {} },
      runtimeOnlyFields: ['particles', 'emissionAccumulator', 'completed', 'rngState']
    },
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
  deepFreeze(PARTICLE_CURVE_KEY_SCHEMA);
  deepFreeze(PARTICLE_CURVE_SCHEMA);
  deepFreeze(PARTICLE_ASSET_SCHEMA);
  deepFreeze(SHADER_NODE_DEFINITIONS);
  deepFreeze(SHADER_PORT_SCHEMA);
  deepFreeze(SHADER_NODE_SCHEMA);
  deepFreeze(SHADER_LINK_SCHEMA);
  deepFreeze(SHADER_GRAPH_SCHEMA);
  deepFreeze(POST_PROCESS_EFFECT_SCHEMA);
  deepFreeze(POST_PROCESS_SCHEMA);
  deepFreeze(JSON_SCHEMAS);

  return Object.freeze({
    DATA_MODEL_ID,
    DATA_MODEL_VERSION,
    COMPONENT_SCHEMA_VERSION,
    PROFILES,
    PROFILE_NAMES,
    COMPONENT_NAME_PATTERN,
    ANIMATION_TRACK_TYPES,
    PARTICLE_CURVE_PROPERTIES,
    PARTICLE_CURVE_INTERPOLATIONS,
    PARTICLE_ASSET_DEFAULTS,
    SHADER_NODE_TYPES,
    SHADER_VALUE_TYPES,
    SHADER_HEX_COLOR_PATTERN,
    SHADER_NODE_DEFINITIONS,
    SHADER_GRAPH_DEFAULTS,
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
    PARTICLE_CURVE_KEY_SCHEMA,
    PARTICLE_CURVE_SCHEMA,
    PARTICLE_ASSET_SCHEMA,
    SHADER_PORT_SCHEMA,
    SHADER_NODE_SCHEMA,
    SHADER_LINK_SCHEMA,
    SHADER_GRAPH_SCHEMA,
    POST_PROCESS_EFFECT_SCHEMA,
    POST_PROCESS_SCHEMA,
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
    normalizeParticleAsset,
    normalizeParticleAssets,
    sampleParticleCurve,
    validateParticleDocument,
    assertParticleDocument,
    normalizeShaderGraph,
    normalizeShaderGraphs,
    validateShaderGraphDocument,
    assertShaderGraphDocument,
    createDefaultComponentRegistry,
    createDefaultEntityCodec
  });
});
