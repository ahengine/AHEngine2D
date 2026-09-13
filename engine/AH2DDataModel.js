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
  const RENDERABLE_SCHEMA = object({
    kind: string(), width: number({ minimum: 0 }), height: number({ minimum: 0 }), color: string(),
    assetId: nullableString(), imageSrc: nullableString(), layer: number(), visible: boolean()
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
  const PREFAB_SCHEMA = object({ assetId: nullableString(), prefabId: nullableString(), overrides: object() });
  const CAMERA_SCHEMA = object({
    active: boolean(), zoom: number({ exclusiveMinimum: 0 }), viewportWidth: number({ minimum: 0 }), viewportHeight: number({ minimum: 0 }),
    near: number(), far: number(), clearColor: string()
  });
  const LIGHT_SCHEMA = object({ color: string(), intensity: number({ minimum: 0 }), radius: number({ minimum: 0 }), type: string(), enabled: boolean() });
  const SHADOW_SCHEMA = object({ opacity: number({ minimum: 0, maximum: 1 }), enabled: boolean(), color: string(), blur: number({ minimum: 0 }) });
  const ANIMATION_AUTHORING_SCHEMA = object({
    clip: string(), playing: boolean(), time: number({ minimum: 0 }), duration: number({ minimum: 0 }), speed: number(), loop: boolean(), frameCount: integer({ minimum: 0 })
  });
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
    Animation: profileSet(ANIMATION_AUTHORING_SCHEMA),
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
  const JSON_SCHEMAS = {
    components: COMPONENT_SCHEMAS,
    componentProfiles: PROFILE_SCHEMAS,
    componentMap: COMPONENT_MAP_SCHEMA,
    entity: ENTITY_SCHEMA
  };

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
      return validateSchema(value, schema, pointer, [], options);
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
    { type: 'Animation', schemas: COMPONENT_SCHEMAS.Animation, defaults: {} },
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

  const BUILTIN_COMPONENT_DEFINITIONS = deepFreeze(BUILTIN_DEFINITIONS.map(definition => {
    const registry = new ComponentSchemaRegistry();
    registry.register(definition);
    return registry.describe(definition.type);
  }));
  deepFreeze(COMPONENT_SCHEMAS);
  deepFreeze(PROFILE_SCHEMAS);
  deepFreeze(ENTITY_SCHEMA);
  deepFreeze(JSON_SCHEMAS);

  return Object.freeze({
    DATA_MODEL_ID,
    DATA_MODEL_VERSION,
    COMPONENT_SCHEMA_VERSION,
    PROFILES,
    PROFILE_NAMES,
    COMPONENT_NAME_PATTERN,
    ComponentSchemaError,
    ComponentSchemaRegistry,
    EntityCodec,
    BUILTIN_COMPONENT_DEFINITIONS,
    COMPONENT_DEFINITIONS: BUILTIN_COMPONENT_DEFINITIONS,
    COMPONENT_SCHEMAS,
    PROFILE_SCHEMAS,
    COMPONENT_MAP_SCHEMA,
    ENTITY_SCHEMA,
    JSON_SCHEMAS,
    isSafeComponentName,
    createDefaultComponentRegistry,
    createDefaultEntityCodec
  });
});
