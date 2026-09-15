'use strict';

const crypto = require('crypto');
const {
  DATA_MODEL_ID, DATA_MODEL_VERSION, COMPONENT_SCHEMA_VERSION, PROFILE_NAMES,
  ComponentSchemaError, EntityCodec, createDefaultComponentRegistry, applyJsonPointerOperation, applyPrefabOverrideOperation, validatePrefabDocument,
  validateAnimationDocument, validateSkeletonDocument, validateParticleDocument, validateShaderGraphDocument, parseJsonPointer, prefabOverridePathAllowed, jsonPointerLookup,
  PREFAB_ASSET_SCHEMA, ANIMATION_CLIP_SCHEMA, PARTICLE_ASSET_SCHEMA, SHADER_GRAPH_SCHEMA, POST_PROCESS_EFFECT_SCHEMA, POST_PROCESS_SCHEMA,
  SHADER_NODE_TYPES, SHADER_VALUE_TYPES, SHADER_NODE_DEFINITIONS
} = require('../AH2DDataModel.js');

const PROTOCOL = 'ah2d.cli/v1';
const PROJECT_VERSION = 4;
const RUNTIMES = new Set(['pixijs', 'phaserjs', 'custom']);
const PHYSICS_BACKENDS = new Set(['box2d', 'builtin']);
const PHYSICS_IMPLEMENTATIONS = Object.freeze({ box2d: 'planck', builtin: 'ah2d-builtin' });
const BODY_TYPES = new Set(['static', 'dynamic', 'kinematic']);
const COLLIDER_SHAPES = new Set(['rectangle', 'box', 'circle']);
const EXIT = Object.freeze({ OK: 0, USAGE: 2, IO: 3, VALIDATION: 4, NOT_FOUND: 5, CONFLICT: 6, ENGINE: 7, INTERNAL: 70 });
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const componentRegistry = createDefaultComponentRegistry();
const entityCodec = new EntityCodec(componentRegistry);
const DATA_MODEL_DESCRIPTOR = Object.freeze({
  id: DATA_MODEL_ID,
  version: DATA_MODEL_VERSION,
  componentSchemaVersion: COMPONENT_SCHEMA_VERSION
});
const DEFAULT_POST_PROCESS_EFFECTS = Object.freeze([
  { id: 'bloom', type: 'bloom', name: 'Bloom', enabled: false, intensity: 0.22, radius: 8, threshold: 0.72 },
  { id: 'vignette', type: 'vignette', name: 'Vignette', enabled: true, intensity: 0.24, softness: 0.68 },
  { id: 'color-adjust', type: 'colorAdjust', name: 'Color Adjust', enabled: true, brightness: 1, contrast: 1, saturation: 1, hue: 0 },
  { id: 'chromatic-aberration', type: 'chromaticAberration', name: 'Chromatic Aberration', enabled: false, amount: 3, intensity: 0.32 },
  { id: 'pixelate', type: 'pixelate', name: 'Pixelate', enabled: false, size: 4 },
  { id: 'crt', type: 'crt', name: 'CRT', enabled: false, scanlines: 0.18, noise: 0.04, curvature: 0.12 }
]);
const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);
const TRANSFORM_EPSILON = 1e-10;
const TRANSFORM_TOLERANCE = 1e-8;

class DomainError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.exitCode = options.exitCode || EXIT.VALIDATION;
    this.pointer = options.pointer || null;
    this.details = options.details || {};
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPlainObject = value => isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const generateId = kind => `${kind}_${crypto.randomBytes(6).toString('hex')}`;
const escapePointer = value => String(value).replace(/~/g, '~0').replace(/\//g, '~1');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const finite = value => Number.isFinite(Number(value));
const createDefaultPostProcess = () => ({ enabled: true, effects: clone(DEFAULT_POST_PROCESS_EFFECTS) });

function diagnostic(severity, code, message, pointer = '', details = {}) {
  return { severity, code, message, pointer, details };
}

function validateDataModelDescriptor(document, diagnostics) {
  if (!Object.prototype.hasOwnProperty.call(document, 'dataModel')) return;
  const value = document.dataModel;
  if (!isPlainObject(value)) {
    diagnostics.push(diagnostic('error', 'E_DATA_MODEL_TYPE', 'dataModel must be a plain object', '/dataModel'));
    return;
  }
  if (value.id !== DATA_MODEL_DESCRIPTOR.id) {
    diagnostics.push(diagnostic('error', 'E_DATA_MODEL_ID', `dataModel.id must be ${DATA_MODEL_DESCRIPTOR.id}`, '/dataModel/id', { expected: DATA_MODEL_DESCRIPTOR.id, actual: value.id ?? null }));
  }
  validateDataModelVersion(value.version, DATA_MODEL_DESCRIPTOR.version, {
    pointer: '/dataModel/version', label: 'dataModel.version', typeCode: 'E_DATA_MODEL_VERSION_TYPE',
    legacyCode: 'W_LEGACY_DATA_MODEL_VERSION', futureCode: 'E_FUTURE_DATA_MODEL_VERSION'
  }, diagnostics);
  validateDataModelVersion(value.componentSchemaVersion, DATA_MODEL_DESCRIPTOR.componentSchemaVersion, {
    pointer: '/dataModel/componentSchemaVersion', label: 'dataModel.componentSchemaVersion', typeCode: 'E_COMPONENT_SCHEMA_VERSION_TYPE',
    legacyCode: 'W_LEGACY_COMPONENT_SCHEMA_VERSION', futureCode: 'E_FUTURE_COMPONENT_SCHEMA_VERSION'
  }, diagnostics);
}

function validateDataModelVersion(value, expected, contract, diagnostics) {
  if (!Number.isInteger(value) || value < 0) {
    diagnostics.push(diagnostic('error', contract.typeCode, `${contract.label} must be a non-negative integer`, contract.pointer, { expected, actual: value ?? null }));
  } else if (value < expected) {
    diagnostics.push(diagnostic('warning', contract.legacyCode, `${contract.label} ${value} is older than supported version ${expected}`, contract.pointer, { expected, actual: value }));
  } else if (value > expected) {
    diagnostics.push(diagnostic('error', contract.futureCode, `${contract.label} ${value} is newer than supported version ${expected}`, contract.pointer, { expected, actual: value }));
  }
}

function componentCall(callback, fallbackPointer = '') {
  try { return callback(); }
  catch (error) {
    if (!(error instanceof ComponentSchemaError)) throw error;
    const pointer = error.pointer || fallbackPointer || '';
    const diagnostics = error.diagnostics?.length
      ? clone(error.diagnostics)
      : [diagnostic('error', error.code, error.message, pointer, error.details || {})];
    const exitCode = error.code === 'E_REQUIRED_COMPONENT' || error.code === 'E_COMPONENT_NAME'
      ? EXIT.CONFLICT
      : EXIT.VALIDATION;
    throw new DomainError(error.code, error.message, {
      exitCode, pointer,
      details: { ...(error.details || {}), diagnostics }
    });
  }
}

function detectDialect(document) {
  if (!isObject(document)) return 'unknown';
  if (document.format === 'AH2D.Particle') return 'particle@1';
  if (document.format === 'AH2D.Animation') return 'animation@1';
  if (Array.isArray(document.scenes)) return 'project@4';
  if (Array.isArray(document.entities)) return 'ecs@3';
  if (Array.isArray(document.scene)) return 'legacy-scene';
  return document.format === 'AH2D' ? 'ah2d-unknown' : 'unknown';
}

function createProject(options = {}) {
  const sceneId = String(options.sceneId || 'main');
  const createdAt = now();
  const objects = clone(options.objects || []);
  return {
    format: 'AH2D',
    version: PROJECT_VERSION,
    dataModel: clone(DATA_MODEL_DESCRIPTOR),
    engine: {
      name: 'AH2D Engine', version: options.engineVersion || '0.3.0',
      renderer: options.runtime || 'custom', runtime: options.runtime || 'custom',
      physics: 'box2d', physicsBackend: 'box2d', physicsImplementation: PHYSICS_IMPLEMENTATIONS.box2d,
      gravity: { x: 0, y: 980 }, pixelsPerMeter: 100,
      compatibleRuntimes: ['pixijs', 'phaserjs', 'custom']
    },
    meta: {
      name: options.name || 'AH2D Project', units: 'px', createdAt, updatedAt: createdAt,
      currentSceneId: sceneId
    },
    currentSceneId: sceneId,
    scenes: [{ id: sceneId, name: options.sceneName || 'Main Scene', objects, updatedAt: createdAt, view: { zoom: 1, pan: { x: 0, y: 0 } } }],
    scene: clone(objects),
    postProcess: createDefaultPostProcess(),
    assets: [], folders: ['Environment', 'Props', 'Characters', 'FX', 'UI', 'Prefabs', 'Animations'],
    prefabs: [], animations: [], particles: [], shaderGraphs: []
  };
}

function migrateDocument(input, options = {}) {
  if (!isObject(input)) throw new DomainError('E_DOCUMENT_TYPE', 'Project document must be a JSON object', { pointer: '' });
  const document = clone(input);
  const dialect = detectDialect(document);
  if (dialect === 'particle@1' || dialect === 'animation@1') {
    throw new DomainError('E_ASSET_DOCUMENT', `${dialect} is an asset document, not an AH2D project`, { pointer: '/format' });
  }
  if (Number(document.version) > PROJECT_VERSION && !options.allowFuture) {
    throw new DomainError('E_FUTURE_VERSION', `Project version ${document.version} is newer than supported version ${PROJECT_VERSION}`, { pointer: '/version' });
  }
  let migrated = false;
  if (!Array.isArray(document.scenes) || !document.scenes.length) {
    const source = Array.isArray(document.scene) ? document.scene : (Array.isArray(document.entities) ? document.entities : []);
    const sceneId = String(document.currentSceneId || document.meta?.currentSceneId || 'main');
    document.scenes = [{ id: sceneId, name: 'Main Scene', objects: clone(source), updatedAt: now(), view: { zoom: 1, pan: { x: 0, y: 0 } } }];
    document.currentSceneId = sceneId;
    migrated = true;
  }
  if (typeof document.engine === 'string') {
    document.engine = {
      name: 'AH2D Engine', version: document.engine, renderer: 'custom', runtime: 'custom',
      physics: 'box2d', physicsBackend: 'box2d', physicsImplementation: PHYSICS_IMPLEMENTATIONS.box2d, gravity: { x: 0, y: 980 }, pixelsPerMeter: 100,
      compatibleRuntimes: ['pixijs', 'phaserjs', 'custom']
    };
    migrated = true;
  } else if (!isObject(document.engine)) {
    document.engine = createProject().engine;
    migrated = true;
  }
  document.meta = isObject(document.meta) ? document.meta : { name: 'AH2D Project', units: 'px' };
  document.assets = Array.isArray(document.assets) ? document.assets : [];
  document.folders = Array.isArray(document.folders) ? document.folders : [];
  if (document.prefabs == null && document.prefab == null) document.prefabs = [];
  document.animations = Array.isArray(document.animations) ? document.animations : [];
  document.particles = Array.isArray(document.particles) ? document.particles : [];
  if (document.shaderGraphs == null) { document.shaderGraphs = []; migrated = true; }
  if (!isObject(document.postProcess)) { document.postProcess = createDefaultPostProcess(); migrated = true; }
  document.format = 'AH2D';
  document.version = PROJECT_VERSION;
  syncActiveMirror(document, { touch: false });
  return { document, dialect, migrated };
}

function resolveScene(document, reference, options = {}) {
  const scenes = Array.isArray(document.scenes) ? document.scenes : [];
  const target = reference == null || reference === '' ? (document.currentSceneId || document.meta?.currentSceneId) : String(reference);
  let scene = scenes.find(item => String(item?.id) === String(target));
  if (!scene && options.allowName && target != null) {
    const matches = scenes.filter(item => String(item?.name || '').toLocaleLowerCase() === String(target).toLocaleLowerCase());
    if (matches.length > 1) throw new DomainError('E_AMBIGUOUS_SCENE', `Scene name is ambiguous: ${target}`, { exitCode: EXIT.CONFLICT, details: { matches: matches.map(item => item.id) } });
    scene = matches[0];
  }
  if (!scene && options.fallback && scenes.length) scene = scenes[0];
  if (!scene) throw new DomainError('E_SCENE_NOT_FOUND', `Scene not found: ${target || '(current)'}`, { exitCode: EXIT.NOT_FOUND, details: { reference: target } });
  return scene;
}

function resolveEntity(scene, reference, options = {}) {
  const objects = Array.isArray(scene.objects) ? scene.objects : [];
  const target = String(reference || '');
  let entity = options.index?.byId instanceof Map
    ? options.index.byId.get(target)
    : objects.find(item => String(item?.id) === target);
  if (!entity && options.allowName) {
    const matches = objects.filter(item => entityName(item).toLocaleLowerCase() === target.toLocaleLowerCase());
    if (matches.length > 1) throw new DomainError('E_AMBIGUOUS_ENTITY', `Entity name is ambiguous: ${target}`, { exitCode: EXIT.CONFLICT, details: { matches: matches.map(item => item.id) } });
    entity = matches[0];
  }
  if (!entity) throw new DomainError('E_ENTITY_NOT_FOUND', `Entity not found: ${target}`, { exitCode: EXIT.NOT_FOUND, details: { sceneId: scene.id, reference: target } });
  return entity;
}

function entityName(entity) {
  if (!isObject(entity)) return 'Game Object';
  const resolved = componentCall(() => entityCodec.resolve(entity, 'Name'));
  return String(resolved.value?.value ?? 'Game Object');
}

function syncActiveMirror(document, options = {}) {
  if (!Array.isArray(document.scenes) || !document.scenes.length) throw new DomainError('E_NO_SCENES', 'Project must contain at least one Scene', { pointer: '/scenes' });
  let active;
  try { active = resolveScene(document, document.currentSceneId || document.meta?.currentSceneId); }
  catch { active = document.scenes[0]; }
  document.currentSceneId = String(active.id);
  document.meta = isObject(document.meta) ? document.meta : {};
  document.meta.currentSceneId = String(active.id);
  if (options.touch !== false) {
    const timestamp = now();
    document.meta.updatedAt = timestamp;
    active.updatedAt = timestamp;
  }
  document.scene = clone(Array.isArray(active.objects) ? active.objects : []);
  return active;
}

function validateDocument(document, options = {}) {
  const diagnostics = [];
  if (!isObject(document)) return [diagnostic('error', 'E_DOCUMENT_TYPE', 'Document must be an object', '')];
  const dialect = detectDialect(document);
  if (dialect === 'unknown' || dialect === 'particle@1' || dialect === 'animation@1') diagnostics.push(diagnostic('error', 'E_PROJECT_DIALECT', `Unsupported project dialect: ${dialect}`, '/format'));
  if (document.format !== 'AH2D') diagnostics.push(diagnostic('error', 'E_FORMAT', 'format must be AH2D', '/format'));
  if (!Number.isInteger(Number(document.version))) diagnostics.push(diagnostic('error', 'E_VERSION_TYPE', 'version must be an integer', '/version'));
  else if (Number(document.version) > PROJECT_VERSION) diagnostics.push(diagnostic('error', 'E_FUTURE_VERSION', `version ${document.version} is not supported`, '/version'));
  else if (Number(document.version) < PROJECT_VERSION) diagnostics.push(diagnostic('warning', 'W_LEGACY_VERSION', `version ${document.version} should be migrated to ${PROJECT_VERSION}`, '/version'));
  validateDataModelDescriptor(document, diagnostics);
  if (!Array.isArray(document.scenes) || !document.scenes.length) {
    diagnostics.push(diagnostic('error', 'E_NO_SCENES', 'scenes must be a non-empty array', '/scenes'));
    return diagnostics;
  }
  const sceneIds = new Map(), sceneNames = new Map(), globalEntityIds = new Map();
  document.scenes.forEach((scene, sceneIndex) => {
    const base = `/scenes/${sceneIndex}`;
    if (!isObject(scene)) { diagnostics.push(diagnostic('error', 'E_SCENE_TYPE', 'Scene must be an object', base)); return; }
    if (typeof scene.id !== 'string' || !scene.id.trim()) diagnostics.push(diagnostic('error', 'E_SCENE_ID', 'Scene id must be a non-empty string', `${base}/id`));
    else if (sceneIds.has(scene.id)) diagnostics.push(diagnostic('error', 'E_DUPLICATE_SCENE_ID', `Duplicate Scene id: ${scene.id}`, `${base}/id`, { first: sceneIds.get(scene.id) }));
    else sceneIds.set(scene.id, `${base}/id`);
    const loweredName = String(scene.name || '').toLocaleLowerCase();
    if (!loweredName) diagnostics.push(diagnostic('warning', 'W_SCENE_NAME', 'Scene has no name', `${base}/name`));
    else if (sceneNames.has(loweredName)) diagnostics.push(diagnostic('warning', 'W_DUPLICATE_SCENE_NAME', `Duplicate Scene name: ${scene.name}`, `${base}/name`));
    else sceneNames.set(loweredName, `${base}/name`);
    if (!Array.isArray(scene.objects)) { diagnostics.push(diagnostic('error', 'E_OBJECTS_TYPE', 'Scene objects must be an array', `${base}/objects`)); return; }
    const ids = new Map(), byId = new Map();
    scene.objects.forEach((entity, entityIndex) => {
      const pointer = `${base}/objects/${entityIndex}`;
      if (!isObject(entity)) { diagnostics.push(diagnostic('error', 'E_ENTITY_TYPE', 'Entity must be an object', pointer)); return; }
      diagnostics.push(...componentCall(() => entityCodec.validate(entity, { pointer, profile: 'authoring', mode: options.strict ? 'strict' : 'compat', strict: Boolean(options.strict) }), pointer));
      if (typeof entity.id === 'string' && entity.id.trim()) {
        if (ids.has(entity.id)) diagnostics.push(diagnostic('error', 'E_DUPLICATE_ENTITY_ID', `Duplicate entity id: ${entity.id}`, `${pointer}/id`, { first: ids.get(entity.id) }));
        else { ids.set(entity.id, `${pointer}/id`); byId.set(entity.id, entity); }
        if (globalEntityIds.has(entity.id) && globalEntityIds.get(entity.id).sceneId !== scene.id) diagnostics.push(diagnostic(options.strict ? 'error' : 'warning', 'W_CROSS_SCENE_ENTITY_ID', `Entity id is reused across Scenes: ${entity.id}`, `${pointer}/id`, { first: globalEntityIds.get(entity.id) }));
        else globalEntityIds.set(entity.id, { sceneId: scene.id, pointer: `${pointer}/id` });
      }
    });
    const parentPointers = new Map();
    scene.objects.forEach((entity, entityIndex) => {
      if (!entity || !Object.prototype.hasOwnProperty.call(entity, 'parentId') || entity.parentId == null) return;
      const pointer = `${base}/objects/${entityIndex}/parentId`;
      if (typeof entity.parentId !== 'string' || !entity.parentId.trim()) {
        diagnostics.push(diagnostic('error', 'E_PARENT_ID', 'parentId must be a non-empty Entity ID string or null', pointer));
        return;
      }
      parentPointers.set(entity.id, pointer);
      if (entity.parentId === entity.id) diagnostics.push(diagnostic('error', 'E_SELF_PARENT', 'Entity cannot parent itself', pointer));
      else if (!byId.has(entity.parentId)) diagnostics.push(diagnostic('error', 'E_DANGLING_PARENT', `Parent does not exist in this Scene: ${entity.parentId}`, pointer));
    });
    const resolved = new Set();
    for (const id of byId.keys()) {
      if (resolved.has(id)) continue;
      const path = [], positions = new Map();
      let cursor = id;
      while (typeof cursor === 'string' && byId.has(cursor) && !resolved.has(cursor)) {
        if (positions.has(cursor)) {
          const cycle = [...path.slice(positions.get(cursor)), cursor];
          const closingEntity = path.at(-1) || cursor;
          diagnostics.push(diagnostic('error', 'E_PARENT_CYCLE', `Parent cycle: ${cycle.join(' -> ')}`, parentPointers.get(closingEntity) || ids.get(cursor) || base, { cycle }));
          break;
        }
        positions.set(cursor, path.length);
        path.push(cursor);
        cursor = byId.get(cursor)?.parentId;
      }
      for (const pathId of path) resolved.add(pathId);
    }
  });
  const current = document.currentSceneId, metaCurrent = document.meta?.currentSceneId;
  if (current !== metaCurrent) diagnostics.push(diagnostic('warning', 'W_CURRENT_SCENE_MISMATCH', 'currentSceneId and meta.currentSceneId differ', '/currentSceneId', { currentSceneId: current, metaCurrentSceneId: metaCurrent }));
  if (!sceneIds.has(String(current))) diagnostics.push(diagnostic('error', 'E_CURRENT_SCENE', `Current Scene does not exist: ${current}`, '/currentSceneId'));
  else {
    const active = document.scenes.find(scene => scene.id === current);
    if (!Array.isArray(document.scene) || !equal(document.scene, active.objects)) diagnostics.push(diagnostic('warning', 'W_LEGACY_MIRROR', 'Legacy scene mirror is not synchronized with the active Scene', '/scene'));
  }
  const runtime = document.engine?.runtime || document.engine?.renderer;
  if (runtime != null && !RUNTIMES.has(String(runtime).toLowerCase())) diagnostics.push(diagnostic('error', 'E_RUNTIME', `Unsupported runtime: ${runtime}`, '/engine/runtime'));
  const requestedPhysics = document.engine?.physics;
  if (requestedPhysics != null && !PHYSICS_BACKENDS.has(String(requestedPhysics).toLowerCase())) diagnostics.push(diagnostic('error', 'E_PHYSICS_BACKEND', `Unsupported physics backend: ${requestedPhysics}`, '/engine/physics'));
  const recordedPhysicsBackend = document.engine?.physicsBackend;
  if (recordedPhysicsBackend != null && !PHYSICS_BACKENDS.has(String(recordedPhysicsBackend).toLowerCase())) diagnostics.push(diagnostic('error', 'E_PHYSICS_BACKEND', `Unsupported physics backend: ${recordedPhysicsBackend}`, '/engine/physicsBackend'));
  if (document.engine?.physicsImplementation != null && (typeof document.engine.physicsImplementation !== 'string' || !document.engine.physicsImplementation.trim())) diagnostics.push(diagnostic('error', 'E_PHYSICS_IMPLEMENTATION', 'physicsImplementation must be a non-empty string', '/engine/physicsImplementation'));
  const gravity = document.engine?.gravity;
  if (gravity && (!finite(gravity.x) || !finite(gravity.y))) diagnostics.push(diagnostic('error', 'E_GRAVITY', 'Gravity x and y must be finite', '/engine/gravity'));
  if (document.engine?.pixelsPerMeter != null && (!finite(document.engine.pixelsPerMeter) || Number(document.engine.pixelsPerMeter) <= 0)) diagnostics.push(diagnostic('error', 'E_PIXELS_PER_METER', 'pixelsPerMeter must be greater than zero', '/engine/pixelsPerMeter'));
  validatePrefabContract(document, diagnostics, options);
  diagnostics.push(...validateAnimationDocument(document, { strict: Boolean(options.strict), entityCodec }));
  diagnostics.push(...validateSkeletonDocument(document, { strict: Boolean(options.strict), entityCodec, validateComponents: false }));
  diagnostics.push(...validateParticleDocument(document, { strict: Boolean(options.strict), entityCodec }));
  diagnostics.push(...validateShaderGraphDocument(document, { strict: Boolean(options.strict) }));
  for (const key of ['assets', 'folders', 'prefab', 'prefabs', 'animations']) if (document[key] != null && !Array.isArray(document[key])) diagnostics.push(diagnostic('error', 'E_RESOURCE_ARRAY', `${key} must be an array`, `/${key}`));
  return diagnostics;
}

function validatePrefabContract(document, diagnostics, options = {}) {
  diagnostics.push(...validatePrefabDocument(document, { entityCodec, strict: Boolean(options.strict) }));
}

function assertValid(document, options = {}) {
  const diagnostics = validateDocument(document, options);
  const failures = diagnostics.filter(item => item.severity === 'error' || (options.warningsAsErrors && item.severity === 'warning'));
  if (failures.length) throw new DomainError('E_PROJECT_INVALID', `Project validation failed with ${failures.length} issue${failures.length === 1 ? '' : 's'}`, { exitCode: EXIT.VALIDATION, details: { diagnostics } });
  return diagnostics;
}

function remapReference(value, ids) {
  return typeof value === 'string' && ids.has(value) ? ids.get(value) : value;
}

function remapRigEntityReferences(entity, ids, options = {}) {
  if (!options.force && prefabMarker(entity)) return entity;
  const skeleton = getComponent(entity, 'Skeleton');
  if (isObject(skeleton.value) && typeof skeleton.value.rootBoneId === 'string' && ids.has(skeleton.value.rootBoneId)) {
    putComponent(entity, 'Skeleton', { ...skeleton.value, rootBoneId: ids.get(skeleton.value.rootBoneId) });
  }
  const ik = getComponent(entity, 'IK');
  if (isObject(ik.value)) {
    const next = clone(ik.value);
    let changed = false;
    if (typeof next.skeletonRootId === 'string' && ids.has(next.skeletonRootId)) {
      next.skeletonRootId = ids.get(next.skeletonRootId);
      changed = true;
    }
    if (Array.isArray(next.bones)) {
      next.bones = next.bones.map(reference => {
        const remapped = remapReference(reference, ids);
        changed = changed || remapped !== reference;
        return remapped;
      });
    }
    if (changed) putComponent(entity, 'IK', next);
  }
  const skin = getComponent(entity, 'Skin');
  if (isObject(skin.value)) {
    const next = clone(skin.value);
    let changed = false;
    if (typeof next.skeletonRootId === 'string' && ids.has(next.skeletonRootId)) {
      next.skeletonRootId = ids.get(next.skeletonRootId);
      changed = true;
    }
    if (Array.isArray(next.vertices)) {
      next.vertices = next.vertices.map(vertex => {
        if (!isObject(vertex) || !Array.isArray(vertex.weights)) return vertex;
        return {
          ...vertex,
          weights: vertex.weights.map(weight => {
            if (!isObject(weight) || typeof weight.boneId !== 'string' || !ids.has(weight.boneId)) return weight;
            changed = true;
            return { ...weight, boneId: ids.get(weight.boneId) };
          })
        };
      });
    }
    if (changed) putComponent(entity, 'Skin', next);
  }
  return entity;
}

function animationClipForBinding(document, animation) {
  if (!isObject(animation) || !Array.isArray(document.animations)) return null;
  const stable = typeof animation.clipId === 'string' ? animation.clipId.trim() : '';
  if (stable) return document.animations.find(clip => isObject(clip) && clip.id === stable) || null;
  const legacy = typeof animation.clip === 'string' ? animation.clip.trim() : '';
  if (!legacy) return null;
  const direct = document.animations.find(clip => isObject(clip) && clip.id === legacy);
  if (direct) return direct;
  const folded = legacy.toLocaleLowerCase();
  const matches = document.animations.filter(clip => isObject(clip) && typeof clip.name === 'string' && clip.name.toLocaleLowerCase() === folded);
  return matches.length === 1 ? matches[0] : null;
}

function remapAnimationClipTargets(clip, ids) {
  const next = clone(clip);
  let changed = false;
  const remapTarget = target => {
    if (!isObject(target) || typeof target.targetEntityId !== 'string' || !ids.has(target.targetEntityId)) return;
    target.targetEntityId = ids.get(target.targetEntityId);
    changed = true;
  };
  remapTarget(next);
  for (const track of Array.isArray(next.tracks) ? next.tracks : []) remapTarget(track);
  return changed ? next : null;
}

function uniqueAnimationCloneIdentity(document, source, suffix) {
  const animations = Array.isArray(document.animations) ? document.animations : (document.animations = []);
  const ids = new Set(animations.filter(isObject).map(clip => clip.id));
  const names = new Set(animations.filter(isObject).map(clip => String(clip.name || '').toLocaleLowerCase()));
  const idBase = `${String(source.id || 'animation')}-${String(suffix || 'copy').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'copy'}`;
  let id = idBase, idIndex = 2;
  while (ids.has(id)) id = `${idBase}-${idIndex++}`;
  const nameBase = `${String(source.name || source.id || 'Animation')} ${String(suffix || 'Copy')}`.trim();
  let name = nameBase, nameIndex = 2;
  while (names.has(name.toLocaleLowerCase())) name = `${nameBase} ${nameIndex++}`;
  return { id, name };
}

function cloneRemappedAnimationBindings(document, entities, ids, options = {}) {
  if (!Array.isArray(document.animations) || !document.animations.length) return { ids: [], bySource: new Map() };
  const clones = new Map();
  const created = [];
  for (const entity of entities) {
    if (!options.force && prefabMarker(entity)) continue;
    const resolved = getComponent(entity, 'Animation');
    const animation = resolved.value;
    const source = animationClipForBinding(document, animation);
    if (!source) continue;
    if (!clones.has(source.id)) {
      const remapped = remapAnimationClipTargets(source, ids);
      if (!remapped) clones.set(source.id, null);
      else {
        const identity = uniqueAnimationCloneIdentity(document, source, options.suffix || 'Copy');
        remapped.id = identity.id;
        remapped.name = identity.name;
        document.animations.push(remapped);
        clones.set(source.id, remapped);
        created.push(remapped.id);
      }
    }
    const copiedClip = clones.get(source.id);
    if (!copiedClip) continue;
    const next = { ...animation, clipId: copiedClip.id };
    if (Object.prototype.hasOwnProperty.call(next, 'clip')) next.clip = copiedClip.id;
    putComponent(entity, 'Animation', next);
  }
  return { ids: created, bySource: new Map([...clones].filter(([, clip]) => clip).map(([sourceId, clip]) => [sourceId, clip.id])) };
}

function remapObjects(objects, options = {}) {
  const ids = new Map();
  for (const entity of objects) if (entity?.id) ids.set(entity.id, generateId('entity'));
  const remapped = objects.map(entity => {
    const next = clone(entity);
    if (next.id) next.id = ids.get(next.id);
    if (next.parentId && ids.has(next.parentId)) next.parentId = ids.get(next.parentId);
    const marker = prefabMarker(next);
    if (marker && ids.has(marker.value.instanceRootId)) {
      attachPrefabMarker(next, { ...marker.value, instanceRootId: ids.get(marker.value.instanceRootId) });
    }
    remapRigEntityReferences(next, ids);
    return next;
  });
  const animationClips = options.document
    ? cloneRemappedAnimationBindings(options.document, remapped, ids, { suffix: options.animationSuffix || 'Copy' })
    : { ids: [], bySource: new Map() };
  return { objects: remapped, idMap: ids, animationClipIds: animationClips.ids };
}

function unpackPrefabGroup(document, group, options = {}) {
  const ids = new Map(group.members.map(member => [String(member.marker.value.sourceEntityId), member.entity.id]));
  const entities = group.members.map(member => member.entity);
  for (const entity of entities) remapRigEntityReferences(entity, ids, { force: true });
  const animationClips = cloneRemappedAnimationBindings(document, entities, ids, {
    force: true,
    suffix: options.animationSuffix || 'Unpacked'
  });
  for (const entity of entities) stripPrefabMarker(entity);
  return { entityIds: entities.map(entity => entity.id), entities, animationClipIds: animationClips.ids, animationClones: animationClips.bySource, idMap: ids };
}

function animationBindingUsesClip(document, entity, clipId) {
  const animation = getComponent(entity, 'Animation').value;
  return animationClipForBinding(document, animation)?.id === clipId;
}

function rebindAnimationClip(entity, clipId) {
  const animation = getComponent(entity, 'Animation').value;
  if (!isObject(animation)) return false;
  const next = { ...animation, clipId };
  if (Object.prototype.hasOwnProperty.call(next, 'clip')) next.clip = clipId;
  putComponent(entity, 'Animation', next);
  return true;
}

function adoptDetachedAnimationClips(document, deletedPrefab, detachedGroups) {
  if (!Array.isArray(document.animations) || !detachedGroups.length) return [];
  const candidates = new Map();
  for (const detached of detachedGroups) {
    for (const [sourceClipId, cloneClipId] of detached.animationClones) {
      if (!candidates.has(sourceClipId)) candidates.set(sourceClipId, []);
      candidates.get(sourceClipId).push({ detached, cloneClipId });
    }
  }
  const externalEntities = [];
  for (const scene of document.scenes || []) externalEntities.push(...(scene.objects || []));
  for (const prefab of prefabAssets(document)) if (prefab !== deletedPrefab) externalEntities.push(...(prefab.entities || []));
  const adopted = [];
  for (const [sourceClipId, options] of candidates) {
    if (externalEntities.some(entity => animationBindingUsesClip(document, entity, sourceClipId))) continue;
    const sourceIndex = document.animations.findIndex(clip => isObject(clip) && clip.id === sourceClipId);
    if (sourceIndex < 0) continue;
    const selected = options[0];
    const remapped = remapAnimationClipTargets(document.animations[sourceIndex], selected.detached.idMap);
    if (!remapped) continue;
    remapped.id = sourceClipId;
    remapped.name = document.animations[sourceIndex].name;
    document.animations[sourceIndex] = remapped;
    for (const entity of selected.detached.entities) {
      if (animationBindingUsesClip(document, entity, selected.cloneClipId)) rebindAnimationClip(entity, sourceClipId);
    }
    const cloneStillBound = [...externalEntities, ...detachedGroups.flatMap(group => group.entities)]
      .some(entity => animationBindingUsesClip(document, entity, selected.cloneClipId));
    if (!cloneStillBound) {
      const cloneIndex = document.animations.findIndex(clip => isObject(clip) && clip.id === selected.cloneClipId);
      if (cloneIndex >= 0) document.animations.splice(cloneIndex, 1);
    }
    adopted.push(sourceClipId);
  }
  return adopted;
}

function buildSceneIndex(scene) {
  const objects = Array.isArray(scene.objects) ? scene.objects : [];
  const byId = new Map(), childrenByParent = new Map();
  for (const entity of objects) {
    const id = String(entity?.id);
    if (!byId.has(id)) byId.set(id, entity);
    if (!entity || typeof entity !== 'object') continue;
    const parentId = entity.parentId == null ? null : entity.parentId;
    const children = childrenByParent.get(parentId) || [];
    children.push(entity);childrenByParent.set(parentId, children);
  }
  return { objects, byId, childrenByParent };
}

function descendants(scene, rootId, index = buildSceneIndex(scene)) {
  const found = new Set(), queue = [rootId];
  for (let head = 0; head < queue.length; head += 1) {
    const parent = queue[head];
    for (const entity of index.childrenByParent.get(parent) || []) {
      if (!found.has(entity.id)) { found.add(entity.id);queue.push(entity.id); }
    }
  }
  return found;
}

function transformNumber(value, fallback, field, entityId) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) throw new DomainError('E_TRANSFORM_NUMBER', 'Transform.' + field + ' must be finite for entity ' + entityId, { pointer: '', details: { entityId, field, value } });
  return number;
}

function localTransformOf(entity) {
  const value = getComponent(entity, 'Transform').value || {};
  return {
    x: transformNumber(value.x, 0, 'x', entity.id),
    y: transformNumber(value.y, 0, 'y', entity.id),
    rotation: transformNumber(value.rotation ?? value.rot, 0, 'rotation', entity.id),
    scaleX: transformNumber(value.scaleX ?? value.sx, 1, 'scaleX', entity.id),
    scaleY: transformNumber(value.scaleY ?? value.sy, 1, 'scaleY', entity.id)
  };
}

function localMatrixOf(entity) {
  const transform = localTransformOf(entity), radians = transform.rotation * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  return [
    cosine * transform.scaleX, sine * transform.scaleX,
    -sine * transform.scaleY, cosine * transform.scaleY,
    transform.x, transform.y
  ];
}

function multiplyMatrices(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

function invertMatrix(matrix, entityId = null) {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= TRANSFORM_EPSILON) {
    throw new DomainError('E_NON_INVERTIBLE_TRANSFORM', 'Cannot preserve world Transform because the new parent world matrix is not invertible', { exitCode: EXIT.CONFLICT, details: { entityId, matrix: clone(matrix) } });
  }
  const inverse = 1 / determinant;
  return [
    matrix[3] * inverse, -matrix[1] * inverse,
    -matrix[2] * inverse, matrix[0] * inverse,
    (matrix[2] * matrix[5] - matrix[3] * matrix[4]) * inverse,
    (matrix[1] * matrix[4] - matrix[0] * matrix[5]) * inverse
  ];
}

function cleanTransformNumber(value) {
  if (Math.abs(value) <= 1e-12) return 0;
  return Number(value.toPrecision(15));
}

function decomposeMatrix(matrix, entityId = null) {
  const [a, b, c, d, x, y] = matrix;
  let rotation = 0, scaleX = Math.hypot(a, b), scaleY;
  if (scaleX > TRANSFORM_EPSILON) {
    rotation = Math.atan2(b, a);
    scaleY = (a * d - b * c) / scaleX;
  } else {
    scaleX = 0;
    scaleY = Math.hypot(c, d);
    rotation = scaleY > TRANSFORM_EPSILON ? Math.atan2(-c, d) : 0;
  }
  const cosine = Math.cos(rotation), sine = Math.sin(rotation);
  const reconstructed = [cosine * scaleX, sine * scaleX, -sine * scaleY, cosine * scaleY];
  const scale = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  const residual = Math.max(Math.abs(a - reconstructed[0]), Math.abs(b - reconstructed[1]), Math.abs(c - reconstructed[2]), Math.abs(d - reconstructed[3]));
  if (!Number.isFinite(residual) || residual > TRANSFORM_TOLERANCE * scale) {
    throw new DomainError('E_TRANSFORM_SHEAR', 'Cannot preserve world Transform because the required local matrix contains shear that AH2D Transform cannot represent', { exitCode: EXIT.CONFLICT, details: { entityId, matrix: clone(matrix), residual } });
  }
  return {
    x: cleanTransformNumber(x), y: cleanTransformNumber(y),
    rotation: cleanTransformNumber(rotation * 180 / Math.PI),
    scaleX: cleanTransformNumber(scaleX), scaleY: cleanTransformNumber(scaleY)
  };
}

function worldMatrixOf(scene, reference, cache = new Map(), index = buildSceneIndex(scene)) {
  const entity = typeof reference === 'object' && reference ? reference : resolveEntity(scene, reference, { index });
  if (cache.has(entity.id)) return cache.get(entity.id);
  const chain = [], positions = new Map();
  let cursor = entity;
  while (cursor && !cache.has(cursor.id)) {
    if (positions.has(cursor.id)) {
      const cycle = [...chain.slice(positions.get(cursor.id)).map(item => item.id), cursor.id];
      throw new DomainError('E_PARENT_CYCLE', 'Parent cycle: ' + cycle.join(' -> '), { exitCode: EXIT.CONFLICT, details: { entityId: cursor.id, cycle } });
    }
    positions.set(cursor.id, chain.length);
    chain.push(cursor);
    cursor = cursor.parentId != null ? resolveEntity(scene, cursor.parentId, { index }) : null;
  }
  let world = cursor ? cache.get(cursor.id) : IDENTITY_MATRIX;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    world = multiplyMatrices(world, localMatrixOf(chain[index]));
    cache.set(chain[index].id, world);
  }
  return cache.get(entity.id);
}

function writeLocalTransform(entity, transform) {
  const current = getComponent(entity, 'Transform');
  const selected = current.candidates.find(candidate => candidate.provenance === current.provenance);
  const source = isPlainObject(selected?.value) ? clone(selected.value) : {};
  const next = { ...source, ...transform };
  if (Object.prototype.hasOwnProperty.call(next, 'rot')) next.rot = transform.rotation;
  if (Object.prototype.hasOwnProperty.call(next, 'sx')) next.sx = transform.scaleX;
  if (Object.prototype.hasOwnProperty.call(next, 'sy')) next.sy = transform.scaleY;
  delete next.world;
  putComponent(entity, 'Transform', next, { provenance: current.provenance });
  return localTransformOf(entity);
}

function defaultEntity(operation = {}) {
  const source = isObject(operation.entity) ? clone(operation.entity) : {};
  return {
    ...source,
    id: String(source.id || operation.id || generateId('entity')),
    name: String(source.name || operation.name || 'Game Object'),
    kind: source.kind || operation.kind || 'object',
    x: Number(source.x ?? operation.x ?? 0), y: Number(source.y ?? operation.y ?? 0),
    w: Number(source.w ?? source.width ?? operation.w ?? operation.width ?? 64),
    h: Number(source.h ?? source.height ?? operation.h ?? operation.height ?? 64),
    rot: Number(source.rot ?? source.rotation ?? operation.rot ?? operation.rotation ?? 0),
    sx: Number(source.sx ?? source.scaleX ?? operation.sx ?? operation.scaleX ?? 1),
    sy: Number(source.sy ?? source.scaleY ?? operation.sy ?? operation.scaleY ?? 1),
    layer: Number(source.layer ?? operation.layer ?? 0), color: source.color || operation.color || '#7b91ad',
    visible: source.visible !== false, locked: Boolean(source.locked)
  };
}

function componentAlias(name) {
  const type = componentRegistry.resolve(name);
  if (!type) return componentCall(() => { throw new ComponentSchemaError('E_COMPONENT_NAME', `Invalid or unknown Component name: ${name || '(empty)'}`); });
  return type;
}

function defaultComponent(type, entity) {
  const canonical = componentAlias(type);
  return componentCall(() => componentRegistry.create(canonical, {}, { entity, profile: 'authoring', mode: 'compat' }));
}

function getComponent(entity, name, create = false) {
  const type = componentAlias(name);
  let resolved = componentCall(() => entityCodec.resolve(entity, type));
  if (!resolved.found && create) {
    componentCall(() => entityCodec.write(entity, type, undefined, { storage: 'preserve', profile: 'authoring', mode: 'compat' }));
    resolved = componentCall(() => entityCodec.resolve(entity, type));
  }
  return resolved;
}

function putComponent(entity, name, value, options = {}) {
  const type = componentAlias(name);
  const current = componentCall(() => entityCodec.resolve(entity, type), options.pointer);
  componentCall(() => entityCodec.write(entity, type, value, {
    storage: options.storage || 'preserve',
    provenance: options.provenance || current.provenance || undefined,
    pointer: options.pointer || '', profile: 'authoring', mode: 'compat'
  }), options.pointer);
  return componentCall(() => entityCodec.resolve(entity, type), options.pointer).value;
}

function removeComponent(entity, name, options = {}) {
  const type = componentAlias(name);
  return componentCall(() => entityCodec.remove(entity, type, { provenance: options.provenance, allLocations: Boolean(options.allLocations) }), options.pointer);
}

function componentStoragePointer(base, storage) {
  if (storage?.startsWith('components.')) return `${base}/components/${escapePointer(storage.slice('components.'.length))}`;
  if (storage === 'flat-name') return `${base}/name`;
  if (storage === 'flat-hidden') return `${base}/visible`;
  if (storage === 'flat-locked') return `${base}/locked`;
  if (storage === 'flat-prefab') return `${base}/prefab`;
  if (storage === 'flat-transform' || storage === 'flat-renderable') return base;
  return `${base}/${escapePointer(storage || '')}`;
}

function componentValuePointer(document, scene, entity, type) {
  const sceneIndex = document.scenes.indexOf(scene), entityIndex = scene.objects.indexOf(entity);
  const base = `/scenes/${sceneIndex}/objects/${entityIndex}`;
  const resolved = getComponent(entity, type);
  const storage = resolved.found ? resolved.storage : componentRegistry.describe(type)?.storage?.preferred;
  return componentStoragePointer(base, storage || `components.${type}`);
}

function renameEntityValue(entity, name) {
  const value = String(name || '').trim();if (!value) throw new DomainError('E_ENTITY_NAME', 'Entity name is required', { exitCode: EXIT.USAGE });
  putComponent(entity, 'Name', { ...getComponent(entity, 'Name').value, value });
  return value;
}

function offsetEntityValue(entity, x, y) {
  const transform = localTransformOf(entity);
  writeLocalTransform(entity, { ...transform, x: transform.x + x, y: transform.y + y });
}

function pathSegments(path) {
  if (Array.isArray(path)) return path;
  const segments = String(path || '').split('.').filter(Boolean);
  if (!segments.length) throw new DomainError('E_PATH', 'Property path is required', { exitCode: EXIT.USAGE });
  if (segments.some(segment => FORBIDDEN_KEYS.has(segment))) throw new DomainError('E_UNSAFE_PATH', 'Unsafe property path', { exitCode: EXIT.CONFLICT });
  return segments;
}

function setPath(target, path, value) {
  const segments = pathSegments(path);let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) { const key = segments[index];if (!isObject(cursor[key]) && !Array.isArray(cursor[key])) cursor[key] = {};cursor = cursor[key]; }
  cursor[segments.at(-1)] = clone(value);return target;
}

function mergePatch(target, patch) {
  if (!isObject(patch)) return clone(patch);
  const output = isObject(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) throw new DomainError('E_UNSAFE_PATCH', `Unsafe patch key: ${key}`, { exitCode: EXIT.CONFLICT });
    if (value === null) delete output[key];else output[key] = isObject(value) ? mergePatch(output[key], value) : clone(value);
  }
  return output;
}

function requireObjectPatch(patch, operation) {
  if (!isObject(patch)) {
    throw new DomainError('E_PATCH_VALUE', `${operation} requires a JSON object`, { exitCode: EXIT.USAGE });
  }
  return patch;
}

function prefabStorage(document, create = false) {
  if (Array.isArray(document.prefabs)) return { field: 'prefabs', list: document.prefabs };
  if (document.prefabs != null) throw new DomainError('E_PREFABS_TYPE', 'prefabs must be an array', { exitCode: EXIT.VALIDATION, pointer: '/prefabs' });
  if (!create) return { field: 'prefabs', list: [] };
  document.prefabs = [];
  return { field: 'prefabs', list: document.prefabs };
}

function prefabAssets(document) {
  return prefabStorage(document).list;
}

function resolvePrefab(document, reference) {
  const target = String(reference || '');
  const prefab = prefabAssets(document).find(item => isObject(item) && String(item.id) === target);
  if (!prefab) throw new DomainError('E_PREFAB_NOT_FOUND', `Prefab Asset not found: ${target}`, { exitCode: EXIT.NOT_FOUND, details: { reference: target } });
  if (!Array.isArray(prefab.entities) || typeof prefab.rootEntityId !== 'string' || !prefab.rootEntityId) {
    throw new DomainError('E_PREFAB_DEFINITION', `Prefab Asset is not a reusable definition: ${target}`, { exitCode: EXIT.VALIDATION, details: { prefabId: target } });
  }
  return prefab;
}

function prefabMarker(entity) {
  const resolved = getComponent(entity, 'PrefabInstance');
  if (!isObject(resolved.value)) return null;
  const lifecycle = ['sourceEntityId', 'instanceRootId'].some(key => Object.prototype.hasOwnProperty.call(resolved.value, key) && resolved.value[key] != null);
  return lifecycle ? { resolved, value: resolved.value } : null;
}

function prefabInstanceError(entity, marker, action, structural = false) {
  const code = structural ? 'E_PREFAB_STRUCTURAL_EDIT' : 'E_PREFAB_INSTANCE_EDIT';
  const message = structural
    ? `Cannot ${action} while Entity ${entity.id} is connected to Prefab ${marker.value.prefabId}; unpack the instance first`
    : `Cannot ${action} directly on connected Prefab Entity ${entity.id}; use prefab override set or unpack the instance first`;
  return new DomainError(code, message, {
    exitCode: EXIT.CONFLICT,
    details: {
      action,
      entityId: entity.id,
      prefabId: marker.value.prefabId,
      instanceRootId: marker.value.instanceRootId,
      sourceEntityId: marker.value.sourceEntityId
    }
  });
}

function assertOrdinaryPrefabEntity(entity, action, structural = false) {
  const marker = prefabMarker(entity);
  if (marker) throw prefabInstanceError(entity, marker, action, structural);
  return entity;
}

function assertNoConnectedPrefabMembers(entities, action) {
  for (const entity of entities) assertOrdinaryPrefabEntity(entity, action, true);
}

function assertPrefabPropertyMutation(entity, path, action) {
  const marker = prefabMarker(entity);
  if (!marker) return;
  let rootPlacement = false;
  if (String(entity.id) === String(marker.value.instanceRootId)) {
    try { rootPlacement = isRootPlacementPath({ ...marker.value, instanceEntityId: entity.id }, normalizeOverridePath(path)); }
    catch (_) { rootPlacement = false; }
  }
  if (!rootPlacement) throw prefabInstanceError(entity, marker, action, false);
}

function assertPrefabComponentMutation(entity, type, action) {
  const marker = prefabMarker(entity);
  if (!marker) return;
  const rootPlacement = String(entity.id) === String(marker.value.instanceRootId) && type === 'Transform';
  if (!rootPlacement) throw prefabInstanceError(entity, marker, action, false);
}

function stripPrefabMarker(entity) {
  removeComponent(entity, 'PrefabInstance', { allLocations: true });
  if (entity.prefab === false) delete entity.prefab;
  return entity;
}

function capturePrefabAsset(scene, root, options = {}) {
  const index = buildSceneIndex(scene);
  const included = new Set([root.id, ...descendants(scene, root.id, index)]);
  const entities = scene.objects.filter(entity => included.has(entity.id)).map(entity => clone(entity));
  const capturedRoot = entities.find(entity => entity.id === root.id);
  if (capturedRoot) {
    delete capturedRoot.parentId;
    writeLocalTransform(capturedRoot, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
  }
  const timestamp = now();
  return {
    ...(isObject(options.base) ? clone(options.base) : {}),
    id: String(options.id || options.base?.id || generateId('prefab')),
    name: String(options.name || options.base?.name || entityName(root) || 'Prefab'),
    rootEntityId: String(root.id),
    entities,
    revision: Number.isInteger(options.revision) ? options.revision : (Number.isInteger(options.base?.revision) ? options.base.revision : 1),
    ...(options.base?.createdAt ? {} : { createdAt: timestamp }),
    updatedAt: timestamp
  };
}

function normalizePrefabAssetRoot(asset) {
  if (!isObject(asset) || !Array.isArray(asset.entities) || typeof asset.rootEntityId !== 'string') return asset;
  const root = asset.entities.find(entity => isObject(entity) && String(entity.id) === String(asset.rootEntityId));
  if (!root) return asset;
  delete root.parentId;
  writeLocalTransform(root, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
  return asset;
}

function normalizeOverridePath(path) {
  const source = String(path || '');
  const segments = source.startsWith('/') ? componentCall(() => parseJsonPointer(source)) : pathSegments(source);
  if (!segments.length) throw new DomainError('E_PREFAB_OVERRIDE_PATH', 'Prefab override path cannot target the complete Entity', { exitCode: EXIT.USAGE });
  const canonical = '/' + segments.map(escapePointer).join('/');
  if (!prefabOverridePathAllowed(canonical)) {
    throw new DomainError('E_PREFAB_OVERRIDE_PATH', `Prefab override cannot change identity, hierarchy, or its PrefabInstance marker: ${source}`, { exitCode: EXIT.CONFLICT });
  }
  return canonical;
}

function overrideSegments(path) {
  return decodePointer(normalizeOverridePath(path));
}

function readRelative(target, path) {
  let cursor = target;
  for (const segment of overrideSegments(path)) {
    if ((cursor == null || (typeof cursor !== 'object')) || !Object.prototype.hasOwnProperty.call(cursor, segment)) return { exists: false, value: undefined };
    cursor = cursor[segment];
  }
  return { exists: true, value: clone(cursor) };
}

function normalizeOverrideRecord(record, sourceExists = true) {
  if (isObject(record) && ['add', 'replace', 'remove'].includes(record.op)) {
    if (record.op === 'remove') return { op: 'remove' };
    if (!Object.prototype.hasOwnProperty.call(record, 'value')) throw new DomainError('E_PREFAB_OVERRIDE_RECORD', `Prefab ${record.op} override requires value`, { exitCode: EXIT.VALIDATION });
    return { op: record.op, value: clone(record.value) };
  }
  if (isObject(record) && record.op === 'set' && Object.prototype.hasOwnProperty.call(record, 'value')) {
    return { op: sourceExists ? 'replace' : 'add', value: clone(record.value) };
  }
  return { op: sourceExists ? 'replace' : 'add', value: clone(record) };
}

function overridePathOwns(owner, nested) {
  return owner === nested || nested.startsWith(`${owner}/`);
}

function clearOverlappingOverrides(overrides, path) {
  const next = isObject(overrides) ? clone(overrides) : {};
  for (const existing of Object.keys(next)) if (overridePathOwns(existing, path) || overridePathOwns(path, existing)) delete next[existing];
  return next;
}

function rebaseOverrideRecord(source, target, path, prior = {}) {
  const sourceState = readRelative(source, path), targetState = readRelative(target, path);
  if ((!sourceState.exists && !targetState.exists) || (sourceState.exists && targetState.exists && equal(sourceState.value, targetState.value))) return null;
  if (!targetState.exists) {
    const record = { ...(isObject(prior) ? clone(prior) : {}), op: 'remove' };
    delete record.value;
    return record;
  }
  return {
    ...(isObject(prior) ? clone(prior) : {}),
    op: sourceState.exists ? 'replace' : 'add',
    value: clone(targetState.value)
  };
}

function applyOverrideRecord(target, path, record, sourceExists = true) {
  const normalized = normalizeOverrideRecord(record, sourceExists);
  componentCall(() => applyPrefabOverrideOperation(target, normalizeOverridePath(path), normalized));
  return normalized;
}

function writeRelativeState(target, path, state) {
  const current = readRelative(target, path);
  if (!state.exists) {
    if (current.exists) componentCall(() => applyJsonPointerOperation(target, normalizeOverridePath(path), { op: 'remove' }));
    return target;
  }
  componentCall(() => applyJsonPointerOperation(target, normalizeOverridePath(path), { op: current.exists ? 'replace' : 'add', value: state.value }));
  return target;
}

function revertOverrideRecord(source, target, path, record) {
  const sourceState = readRelative(source, path), targetState = readRelative(target, path);
  const operation = normalizeOverrideRecord(record, sourceState.exists);
  if (operation.op === 'add') {
    if (targetState.exists) componentCall(() => applyJsonPointerOperation(target, normalizeOverridePath(path), { op: 'remove' }));
    return operation;
  }
  if (!sourceState.exists) {
    if (targetState.exists) componentCall(() => applyJsonPointerOperation(target, normalizeOverridePath(path), { op: 'remove' }));
    return operation;
  }
  componentCall(() => applyJsonPointerOperation(target, normalizeOverridePath(path), {
    op: operation.op === 'remove' ? 'add' : (targetState.exists ? 'replace' : 'add'),
    value: sourceState.value
  }));
  return operation;
}

function isRootPlacementPath(marker, path) {
  if (String(marker.instanceRootId) === '' || String(marker.instanceRootId) !== String(marker.instanceEntityId || '')) return false;
  const segments = overrideSegments(path);
  const first = String(segments[0] || '').toLowerCase();
  return ['x', 'y', 'rot', 'rotation', 'sx', 'sy', 'scalex', 'scaley'].includes(first)
    || first === 'transform'
    || (first === 'components' && String(segments[1] || '').toLowerCase() === 'transform');
}

function instanceGroups(document, prefabId = null) {
  const groups = [];
  for (const scene of document.scenes || []) {
    const byRoot = new Map();
    for (const entity of scene.objects || []) {
      const marker = prefabMarker(entity);
      if (!marker || (prefabId != null && String(marker.value.prefabId) !== String(prefabId))) continue;
      const rootId = String(marker.value.instanceRootId || '');
      if (!rootId) continue;
      const key = `${marker.value.prefabId}\u0000${rootId}`;
      if (!byRoot.has(key)) byRoot.set(key, { scene, prefabId: String(marker.value.prefabId), rootId, members: [] });
      byRoot.get(key).members.push({ entity, marker });
    }
    groups.push(...byRoot.values());
  }
  return groups;
}

function instanceGroupForEntity(document, scene, entity) {
  const marker = prefabMarker(entity);
  if (!marker) throw new DomainError('E_PREFAB_INSTANCE', `Entity is not a connected Prefab Instance: ${entity.id}`, { exitCode: EXIT.CONFLICT, details: { sceneId: scene.id, entityId: entity.id } });
  const group = instanceGroups(document, marker.value.prefabId).find(item => item.scene.id === scene.id && item.rootId === String(marker.value.instanceRootId));
  if (!group) throw new DomainError('E_PREFAB_INSTANCE', `Prefab Instance group is incomplete: ${marker.value.instanceRootId}`, { exitCode: EXIT.CONFLICT });
  return { marker, group, prefab: resolvePrefab(document, marker.value.prefabId) };
}

function nextEntityId(used, preferred = null) {
  if (preferred != null) {
    const id = String(preferred);
    if (!id) throw new DomainError('E_ENTITY_ID', 'Instance root Entity ID must be non-empty', { exitCode: EXIT.USAGE });
    if (used.has(id)) throw new DomainError('E_ENTITY_EXISTS', `Entity already exists: ${id}`, { exitCode: EXIT.CONFLICT });
    used.add(id);
    return id;
  }
  let id;
  do { id = generateId('entity'); } while (used.has(id));
  used.add(id);
  return id;
}

function attachPrefabMarker(entity, value) {
  const resolved = getComponent(entity, 'PrefabInstance'), current = isObject(resolved.value) ? resolved.value : null;
  putComponent(entity, 'PrefabInstance', { ...(isObject(current) ? clone(current) : {}), ...clone(value) });
}

function instantiatePrefab(document, scene, prefab, operation = {}) {
  const source = Array.isArray(prefab.entities) ? prefab.entities : [];
  const sourceRoot = source.find(entity => entity?.id === prefab.rootEntityId);
  if (!sourceRoot) throw new DomainError('E_PREFAB_ROOT', `Prefab root Entity does not exist: ${prefab.rootEntityId}`, { exitCode: EXIT.VALIDATION });
  const used = new Set(scene.objects.map(entity => String(entity?.id)));
  const ids = new Map();
  ids.set(sourceRoot.id, nextEntityId(used, operation.rootId || operation.id));
  for (const entity of source) if (entity !== sourceRoot) ids.set(entity.id, nextEntityId(used));
  const parentId = operation.parentId == null || operation.parentId === '' ? null : String(operation.parentId);
  if (parentId) assertOrdinaryPrefabEntity(resolveEntity(scene, parentId), 'instantiate a Prefab as a child of a connected instance', true);
  const instanceRootId = ids.get(sourceRoot.id);
  const entities = source.map(sourceEntity => {
    const sourceMarker = getComponent(sourceEntity, 'PrefabInstance');
    const entity = stripPrefabMarker(clone(sourceEntity));
    entity.id = ids.get(sourceEntity.id);
    if (sourceEntity.id === sourceRoot.id) {
      if (parentId) entity.parentId = parentId; else delete entity.parentId;
      if (operation.x != null || operation.y != null) {
        const transform = localTransformOf(entity);
        writeLocalTransform(entity, { ...transform, x: operation.x == null ? transform.x : Number(operation.x), y: operation.y == null ? transform.y : Number(operation.y) });
      }
    } else if (sourceEntity.parentId && ids.has(sourceEntity.parentId)) entity.parentId = ids.get(sourceEntity.parentId);
    attachPrefabMarker(entity, {
      ...(isObject(sourceMarker.value) ? clone(sourceMarker.value) : {}),
      prefabId: prefab.id, sourceEntityId: sourceEntity.id, instanceRootId, prefabRevision: Number.isInteger(prefab.revision) ? prefab.revision : 0, overrides: {}
    });
    return entity;
  });
  scene.objects.push(...entities);
  return { sceneId: scene.id, prefabId: prefab.id, entityId: instanceRootId, entityIds: entities.map(entity => entity.id), idMap: Object.fromEntries(ids) };
}

function preserveRootPlacement(source, current) {
  const sourceCandidates = componentCall(() => entityCodec.resolve(source, 'Transform', { clone: true })).candidates.filter(candidate => candidate.explicit);
  const placementCandidates = componentCall(() => entityCodec.resolve(current, 'Transform', { clone: true })).candidates.filter(candidate => candidate.explicit);

  for (const candidate of sourceCandidates) {
    const provenance = candidate.provenance;
    if (provenance?.startsWith('components.')) {
      if (isObject(source.components)) delete source.components[provenance.slice('components.'.length)];
    } else if (provenance === 'transform') delete source.transform;
    else if (provenance === 'flat-transform') {
      for (const key of ['x', 'y', 'rot', 'rotation', 'sx', 'sy', 'scaleX', 'scaleY']) delete source[key];
    }
  }

  for (const candidate of placementCandidates) {
    if (candidate.provenance === 'flat-transform') {
      // The codec identifies this authored location, while copying the raw
      // aliases retains whether the document used rot/sx/sy or their long
      // spellings when several Transform locations coexist.
      for (const key of ['x', 'y', 'rot', 'rotation', 'sx', 'sy', 'scaleX', 'scaleY']) {
        if (Object.prototype.hasOwnProperty.call(current, key)) source[key] = clone(current[key]);
      }
      continue;
    }
    componentCall(() => entityCodec.write(source, 'Transform', candidate.value, {
      storage: 'preserve', provenance: candidate.provenance, profile: 'authoring', mode: 'compat'
    }));
  }

  if (isObject(source.components) && !Object.keys(source.components).length) delete source.components;
}

function syncPrefabInstances(document, prefab, options = {}) {
  const previousRevision = Number.isInteger(options.previousRevision) ? options.previousRevision : null;
  let instanceCount = 0, staleInstanceCount = 0, created = 0, removed = 0;
  for (const group of instanceGroups(document, prefab.id)) {
    if (previousRevision != null && !group.members.every(member => member.marker.value.prefabRevision === previousRevision)) {
      staleInstanceCount += 1;
      continue;
    }
    const scene = group.scene, currentObjects = scene.objects;
    const currentBySource = new Map(group.members.map(member => [String(member.marker.value.sourceEntityId), member]));
    const rootMember = group.members.find(member => member.entity.id === group.rootId);
    if (!rootMember) throw new DomainError('E_PREFAB_INSTANCE_ROOT', `Prefab Instance root does not exist: ${group.rootId}`, { exitCode: EXIT.CONFLICT });
    const used = new Set(currentObjects.filter(entity => !group.members.some(member => member.entity.id === entity.id)).map(entity => String(entity.id)));
    const ids = new Map();
    ids.set(prefab.rootEntityId, group.rootId);used.add(group.rootId);
    for (const sourceEntity of prefab.entities) {
      if (sourceEntity.id === prefab.rootEntityId) continue;
      const existing = currentBySource.get(String(sourceEntity.id));
      ids.set(sourceEntity.id, existing ? existing.entity.id : nextEntityId(used));
      if (!existing) created += 1;
    }
    const rebuilt = prefab.entities.map(sourceEntity => {
      const existing = sourceEntity.id === prefab.rootEntityId ? rootMember : currentBySource.get(String(sourceEntity.id));
      const sourceMarker = getComponent(sourceEntity, 'PrefabInstance');
      const entity = stripPrefabMarker(clone(sourceEntity));
      entity.id = ids.get(sourceEntity.id);
      if (sourceEntity.id === prefab.rootEntityId) {
        if (rootMember.entity.parentId) entity.parentId = rootMember.entity.parentId; else delete entity.parentId;
        preserveRootPlacement(entity, rootMember.entity);
      } else if (sourceEntity.parentId && ids.has(sourceEntity.parentId)) entity.parentId = ids.get(sourceEntity.parentId);
      const previousOverrides = isObject(existing?.marker.value.overrides) ? existing.marker.value.overrides : {};
      const overrides = {};
      for (const [path, record] of Object.entries(previousOverrides)) {
        const effective = readRelative(existing.entity, path);
        try { writeRelativeState(entity, path, effective); }
        catch (error) {
          throw new DomainError('E_PREFAB_OVERRIDE_REBASE', `Cannot preserve Prefab override ${path} while rebuilding Asset ${prefab.id}`, {
            exitCode: EXIT.CONFLICT,
            details: { prefabId: prefab.id, instanceRootId: group.rootId, entityId: existing.entity.id, sourceEntityId: sourceEntity.id, path, cause: error.code || error.message }
          });
        }
        const rebased = rebaseOverrideRecord(sourceEntity, entity, path, record);
        if (rebased) overrides[path] = rebased;
      }
      attachPrefabMarker(entity, {
        ...(isObject(sourceMarker.value) ? clone(sourceMarker.value) : {}),
        ...(isObject(existing?.marker.value) ? clone(existing.marker.value) : {}),
        prefabId: prefab.id, sourceEntityId: sourceEntity.id, instanceRootId: group.rootId, prefabRevision: Number.isInteger(prefab.revision) ? prefab.revision : 0, overrides
      });
      return entity;
    });
    const groupIds = new Set(group.members.map(member => member.entity.id));
    const rebuiltIds = new Set(rebuilt.map(entity => entity.id));
    const deletedIds = new Set([...groupIds].filter(id => !rebuiltIds.has(id)));
    removed += deletedIds.size;
    for (const entity of currentObjects) if (!groupIds.has(entity.id) && deletedIds.has(entity.parentId)) entity.parentId = group.rootId;
    const insertion = Math.min(...group.members.map(member => currentObjects.indexOf(member.entity)).filter(index => index >= 0));
    const retained = currentObjects.filter(entity => !groupIds.has(entity.id));
    retained.splice(Math.min(insertion, retained.length), 0, ...rebuilt);
    scene.objects = retained;
    instanceCount += 1;
  }
  return { instanceCount, staleInstanceCount, createdEntityCount: created, removedEntityCount: removed };
}

function sourceEntityForMarker(prefab, marker) {
  const source = prefab.entities.find(entity => String(entity?.id) === String(marker.sourceEntityId));
  if (!source) throw new DomainError('E_PREFAB_SOURCE_ENTITY', `Prefab source Entity does not exist: ${marker.sourceEntityId}`, { exitCode: EXIT.CONFLICT, details: { prefabId: prefab.id, sourceEntityId: marker.sourceEntityId } });
  return source;
}

function overrideEntries(document, scene, entity, all = false) {
  const context = instanceGroupForEntity(document, scene, entity);
  const members = all ? context.group.members : [context.group.members.find(member => member.entity.id === entity.id)];
  const entries = [];
  for (const member of members.filter(Boolean)) {
    const source = sourceEntityForMarker(context.prefab, member.marker.value);
    const overrides = isObject(member.marker.value.overrides) ? member.marker.value.overrides : {};
    for (const [path, stored] of Object.entries(overrides)) {
      const sourceState = readRelative(source, path), currentState = readRelative(member.entity, path);
      entries.push({
        entityId: member.entity.id, sourceEntityId: source.id, path: normalizeOverridePath(path),
        source: { exists: sourceState.exists, ...(sourceState.exists ? { value: sourceState.value } : {}) },
        current: { exists: currentState.exists, ...(currentState.exists ? { value: currentState.value } : {}) },
        override: normalizeOverrideRecord(stored, sourceState.exists)
      });
    }
  }
  return { context, entries };
}

function inspectPrefabOverrides(document, scene, entity, options = {}) {
  const { context, entries } = overrideEntries(document, scene, entity, Boolean(options.all));
  return { sceneId: scene.id, prefabId: context.prefab.id, instanceRootId: context.group.rootId, entityId: entity.id, overrides: entries };
}

function pointerFromSegments(segments) {
  return '/' + segments.map(escapePointer).join('/');
}

function syncArrayMutation(source, target, path, overrides, operation) {
  if (!['add', 'remove'].includes(operation.op)) return null;
  const segments = componentCall(() => parseJsonPointer(path));
  const rawIndex = segments.at(-1);
  if (!/^(0|[1-9]\d*)$/.test(rawIndex || '')) return null;
  const parentSegments = segments.slice(0, -1);
  const parentPath = parentSegments.length ? pointerFromSegments(parentSegments) : '';
  const sourceParent = componentCall(() => jsonPointerLookup(source, parentPath, { allowRoot: true }));
  const targetParent = componentCall(() => jsonPointerLookup(target, parentPath, { allowRoot: true }));
  if (!sourceParent.found || !targetParent.found || !Array.isArray(sourceParent.value) || !Array.isArray(targetParent.value)) return null;

  const index = Number(rawIndex);
  const next = isObject(overrides) ? clone(overrides) : {};
  const entries = Object.keys(next).map(existing => {
    let parts;
    try { parts = parseJsonPointer(existing); }
    catch (_) { return null; }
    if (parts.length <= parentSegments.length ||
        parentSegments.some((segment, position) => parts[position] !== segment) ||
        !/^(0|[1-9]\d*)$/.test(parts[parentSegments.length])) return null;
    return { path: existing, parts, index: Number(parts[parentSegments.length]), record: next[existing] };
  }).filter(Boolean);
  const ancestorOwner = Object.keys(next)
    .filter(existing => existing !== path && path.startsWith(`${existing}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (ancestorOwner) {
    const rebased = rebaseOverrideRecord(source, target, ancestorOwner, next[ancestorOwner]);
    if (rebased) next[ancestorOwner] = rebased;
    else delete next[ancestorOwner];
    return next;
  }

  if (operation.op === 'remove' && entries.some(entry => entry.index === index)) {
    const prior = entries.find(entry => entry.index === index)?.record || {};
    for (const entry of entries) delete next[entry.path];
    const promoted = rebaseOverrideRecord(source, target, parentPath, prior);
    if (promoted) next[parentPath] = promoted;
    return next;
  }

  applyOverrideRecord(target, path, operation, readRelative(source, path).exists);
  for (const entry of entries) {
    if (operation.op === 'remove' && entry.index <= index) continue;
    if (operation.op === 'add' && entry.index < index) continue;
    delete next[entry.path];
    const shiftedParts = entry.parts.slice();
    shiftedParts[parentSegments.length] = String(entry.index + (operation.op === 'add' ? 1 : -1));
    const shiftedPath = pointerFromSegments(shiftedParts);
    const rebased = rebaseOverrideRecord(source, target, shiftedPath, entry.record);
    if (rebased) next[shiftedPath] = rebased;
  }
  return next;
}

function syncPathPreservingOverrides(source, target, path, overrides, operation) {
  const next = isObject(overrides) ? clone(overrides) : {}, paths = Object.keys(next);
  const arrayResult = syncArrayMutation(source, target, path, next, operation);
  if (arrayResult) return arrayResult;
  const owner = paths
    .filter(existing => existing === path || path.startsWith(`${existing}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (owner) {
    const rebased = rebaseOverrideRecord(source, target, owner, next[owner]);
    if (rebased) next[owner] = rebased;
    else delete next[owner];
    return next;
  }
  const branchBefore = readRelative(target, path);
  const descendants = paths.filter(existing => overridePathOwns(path, existing) && existing !== path).map(existing => ({ path: existing, effective: readRelative(target, existing) }));
  applyOverrideRecord(target, path, operation, readRelative(source, path).exists);
  for (const descendant of descendants) {
    try { writeRelativeState(target, descendant.path, descendant.effective); }
    catch (error) {
      if (!branchBefore.exists) throw error;
      writeRelativeState(target, path, branchBefore);
      const prior = next[descendant.path];
      for (const existing of Object.keys(next)) {
        if (existing === path || existing.startsWith(`${path}/`)) delete next[existing];
      }
      const promoted = rebaseOverrideRecord(source, target, path, prior);
      if (promoted) next[path] = promoted;
      return next;
    }
    const sourceState = readRelative(source, descendant.path);
    if (!descendant.effective.exists && !sourceState.exists) delete next[descendant.path];
    else next[descendant.path] = descendant.effective.exists
      ? { ...next[descendant.path], op: sourceState.exists ? 'replace' : 'add', value: clone(descendant.effective.value) }
      : { ...next[descendant.path], op: 'remove' };
  }
  return next;
}

function syncPrefabPath(document, prefab, sourceEntity, path, operation, applying = null, previousRevision = null) {
  let synced = 0;
  for (const group of instanceGroups(document, prefab.id)) {
    if (previousRevision != null && !group.members.every(member => member.marker.value.prefabRevision === previousRevision)) continue;
    for (const member of group.members) {
      if (String(member.marker.value.sourceEntityId) !== String(sourceEntity.id)) continue;
      if (applying && String(group.scene.id) === String(applying.sceneId) && String(group.rootId) === String(applying.instanceRootId) && String(member.entity.id) === String(applying.entityId)) continue;
      if (member.entity.id === group.rootId && isRootPlacementPath({ ...member.marker.value, instanceEntityId: member.entity.id }, path)) continue;
      const overrides = syncPathPreservingOverrides(sourceEntity, member.entity, path, member.marker.value.overrides, operation);
      attachPrefabMarker(member.entity, { ...member.marker.value, overrides });
      synced += 1;
    }
  }
  return synced;
}

function operationScene(document, operation) {
  return resolveScene(document, operation.sceneId || operation.scene || operation.sceneName || null, { allowName: operation.sceneName != null });
}

function applyOperationMutable(document, operation) {
  if (!isObject(operation) || typeof operation.op !== 'string') throw new DomainError('E_OPERATION', 'Each operation needs an op string', { exitCode: EXIT.USAGE });
  const op = operation.op.toLowerCase();
  if (op === 'scene.create') {
    const id = String(operation.id || generateId('scene'));if (document.scenes.some(scene => scene.id === id)) throw new DomainError('E_SCENE_EXISTS', `Scene already exists: ${id}`, { exitCode: EXIT.CONFLICT });
    const scene = { id, name: String(operation.name || 'New Scene'), objects: clone(operation.objects || []), updatedAt: now(), view: clone(operation.view || { zoom: 1, pan: { x: 0, y: 0 } }) };
    document.scenes.push(scene);if (operation.activate) document.currentSceneId = id;return { sceneId: id, name: scene.name };
  }
  if (op === 'scene.clone') {
    const source = operationScene(document, operation), id = String(operation.id || generateId('scene'));
    if (document.scenes.some(scene => scene.id === id)) throw new DomainError('E_SCENE_EXISTS', `Scene already exists: ${id}`, { exitCode: EXIT.CONFLICT });
    const remapped = operation.keepIds
      ? { objects: clone(source.objects), animationClipIds: [] }
      : remapObjects(source.objects, { document, animationSuffix: 'Scene Copy' });
    const scene = { ...clone(source), id, name: String(operation.name || `${source.name} Copy`), objects: remapped.objects, updatedAt: now() };
    document.scenes.push(scene);if (operation.activate) document.currentSceneId = id;return { sceneId: id, name: scene.name, objectCount: scene.objects.length };
  }
  if (op === 'scene.rename') { const scene = operationScene(document, operation);scene.name = String(operation.name || '').trim();if (!scene.name) throw new DomainError('E_SCENE_NAME', 'Scene name is required', { exitCode: EXIT.USAGE });return { sceneId: scene.id, name: scene.name }; }
  if (op === 'scene.select') { const scene = operationScene(document, operation);document.currentSceneId = scene.id;return { sceneId: scene.id, name: scene.name }; }
  if (op === 'scene.delete') {
    const scene = operationScene(document, operation), index = document.scenes.indexOf(scene);
    if (document.scenes.length === 1 && !operation.force) throw new DomainError('E_LAST_SCENE', 'Cannot delete the last Scene without force', { exitCode: EXIT.CONFLICT });
    document.scenes.splice(index, 1);
    if (!document.scenes.length) { const replacement = { id: 'main', name: 'Main Scene', objects: [], updatedAt: now(), view: { zoom: 1, pan: { x: 0, y: 0 } } };document.scenes.push(replacement);document.currentSceneId = replacement.id; }
    else if (document.currentSceneId === scene.id) document.currentSceneId = document.scenes[Math.min(index, document.scenes.length - 1)].id;
    return { sceneId: scene.id, deleted: true, currentSceneId: document.currentSceneId };
  }
  if (op.startsWith('prefab.')) {
    if (op === 'prefab.asset.create') {
      const storage = prefabStorage(document, true), id = String(operation.prefabId || operation.id || generateId('prefab'));
      if (!id) throw new DomainError('E_PREFAB_ID', 'Prefab Asset id is required', { exitCode: EXIT.USAGE });
      if (storage.list.some(item => isObject(item) && String(item.id) === id)) throw new DomainError('E_PREFAB_EXISTS', `Prefab Asset already exists: ${id}`, { exitCode: EXIT.CONFLICT });
      let asset, sourceScene = null, sourceRoot = null;
      if (operation.value !== undefined) {
        if (!isObject(operation.value)) throw new DomainError('E_PREFAB_VALUE', 'Prefab Asset value must be a JSON object', { exitCode: EXIT.USAGE });
        asset = { ...clone(operation.value), id, name: String(operation.name || operation.value.name || 'Prefab'), revision: Number.isInteger(operation.value.revision) ? operation.value.revision : 1 };
      } else {
        sourceScene = operationScene(document, operation);
        sourceRoot = resolveEntity(sourceScene, operation.entityId || operation.entity || operation.entityName, { allowName: operation.entityName != null });
        const sourceIds = new Set([sourceRoot.id, ...descendants(sourceScene, sourceRoot.id)]);
        for (const entity of sourceScene.objects.filter(item => sourceIds.has(item.id))) {
          if (prefabMarker(entity)) throw new DomainError('E_PREFAB_NESTED_INSTANCE', `Connected Prefab Instance must be unpacked before creating an Asset from it: ${entity.id}`, { exitCode: EXIT.CONFLICT, details: { entityId: entity.id } });
        }
        asset = capturePrefabAsset(sourceScene, sourceRoot, { id, name: operation.name });
      }
      normalizePrefabAssetRoot(asset);
      storage.list.push(asset);
      if (sourceScene && sourceRoot) {
        const sourceIds = new Set(asset.entities.map(entity => entity.id));
        for (const entity of sourceScene.objects.filter(item => sourceIds.has(item.id))) {
          attachPrefabMarker(entity, { prefabId: asset.id, sourceEntityId: entity.id, instanceRootId: sourceRoot.id, prefabRevision: asset.revision, overrides: {} });
        }
      }
      return { prefabId: asset.id, name: asset.name, rootEntityId: asset.rootEntityId, entityCount: asset.entities?.length || 0, sourceSceneId: sourceScene?.id || null, sourceEntityId: sourceRoot?.id || null };
    }
    if (op === 'prefab.asset.update') {
      const storage = prefabStorage(document), current = resolvePrefab(document, operation.prefabId || operation.id), index = storage.list.indexOf(current);
      const previousRevision = Number.isInteger(current.revision) ? current.revision : 0;
      let asset;
      if (operation.patch !== undefined) {
        asset = mergePatch(current, requireObjectPatch(operation.patch, op));
        asset.id = current.id;
        asset.revision = (Number.isInteger(current.revision) ? current.revision : 0) + 1;
        asset.updatedAt = now();
      } else {
        const scene = operationScene(document, operation), root = resolveEntity(scene, operation.entityId || operation.entity || operation.entityName, { allowName: operation.entityName != null });
        const index = buildSceneIndex(scene), capturedIds = new Set([root.id, ...descendants(scene, root.id, index)]);
        const connected = scene.objects.find(entity => capturedIds.has(entity.id) && prefabMarker(entity));
        if (connected) throw new DomainError('E_PREFAB_UPDATE_SOURCE_INSTANCE', 'Recapture Prefab Asset from an ordinary Scene subtree; use override apply for a connected instance', { exitCode: EXIT.CONFLICT, details: { sceneId: scene.id, entityId: connected.id, rootEntityId: root.id, prefabId: current.id } });
        asset = capturePrefabAsset(scene, root, { base: current, id: current.id, name: operation.name || current.name, revision: (Number.isInteger(current.revision) ? current.revision : 0) + 1 });
      }
      if (operation.name != null) asset.name = String(operation.name);
      normalizePrefabAssetRoot(asset);
      if (!Array.isArray(asset.entities) || typeof asset.rootEntityId !== 'string' || !asset.entities.some(entity => entity?.id === asset.rootEntityId)) {
        throw new DomainError('E_PREFAB_DEFINITION', `Updated Prefab Asset is missing a valid root/entities definition: ${current.id}`, { exitCode: EXIT.VALIDATION });
      }
      storage.list[index] = asset;
      const synchronized = syncPrefabInstances(document, asset, { previousRevision });
      return { prefabId: asset.id, name: asset.name, rootEntityId: asset.rootEntityId, entityCount: asset.entities.length, synchronized };
    }
    if (op === 'prefab.asset.delete') {
      const storage = prefabStorage(document), prefab = resolvePrefab(document, operation.prefabId || operation.id), groups = instanceGroups(document, prefab.id);
      if (groups.length && !operation.unpackInstances) {
        throw new DomainError('E_PREFAB_IN_USE', `Prefab Asset has ${groups.length} connected instance${groups.length === 1 ? '' : 's'}; use --unpack-instances to keep their Entities`, { exitCode: EXIT.CONFLICT, details: { prefabId: prefab.id, instanceRootIds: groups.map(group => group.rootId) } });
      }
      let unpackedEntityCount = 0;
      const detachedGroups = [];
      for (const group of groups) {
        const detached = unpackPrefabGroup(document, group);
        detachedGroups.push(detached);
        unpackedEntityCount += detached.entityIds.length;
      }
      adoptDetachedAnimationClips(document, prefab, detachedGroups);
      storage.list.splice(storage.list.indexOf(prefab), 1);
      return { prefabId: prefab.id, deleted: true, unpackedInstanceCount: groups.length, unpackedEntityCount };
    }
    if (op === 'prefab.instantiate') {
      const scene = operationScene(document, operation), prefab = resolvePrefab(document, operation.prefabId || operation.id);
      return instantiatePrefab(document, scene, prefab, operation);
    }
    if (op === 'prefab.override.set') {
      const scene = operationScene(document, operation), entity = resolveEntity(scene, operation.entityId || operation.entity || operation.entityName, { allowName: operation.entityName != null });
      const { marker, prefab } = instanceGroupForEntity(document, scene, entity), source = sourceEntityForMarker(prefab, marker.value), path = normalizeOverridePath(operation.path);
      if (entity.id === marker.value.instanceRootId && isRootPlacementPath({ ...marker.value, instanceEntityId: entity.id }, path)) {
        throw new DomainError('E_PREFAB_PLACEMENT_PATH', 'Prefab Instance root Transform is placement state; edit it with entity/component commands instead of an override', { exitCode: EXIT.CONFLICT, details: { entityId: entity.id, path } });
      }
      const sourceState = readRelative(source, path), currentOverrides = isObject(marker.value.overrides) ? marker.value.overrides : {};
      const ownerPath = Object.keys(currentOverrides).find(existing => existing !== path && overridePathOwns(existing, path)) || null;
      const ownerRecord = ownerPath ? currentOverrides[ownerPath] : null;
      const exactRecord = isObject(currentOverrides[path]) ? currentOverrides[path] : {};
      const overrides = clearOverlappingOverrides(currentOverrides, path);
      let record;
      if (operation.remove === true) {
        writeRelativeState(entity, path, { exists: false });
        if (ownerPath) {
          record = rebaseOverrideRecord(source, entity, ownerPath, ownerRecord);
          if (record) overrides[ownerPath] = record;
          attachPrefabMarker(entity, { ...marker.value, overrides });
          return { sceneId: scene.id, prefabId: prefab.id, instanceRootId: marker.value.instanceRootId, entityId: entity.id, sourceEntityId: source.id, path, storedPath: ownerPath, override: record, reverted: record == null };
        }
        if (!sourceState.exists) {
          attachPrefabMarker(entity, { ...marker.value, overrides });
          return { sceneId: scene.id, prefabId: prefab.id, instanceRootId: marker.value.instanceRootId, entityId: entity.id, sourceEntityId: source.id, path, override: null, reverted: true };
        }
        record = { ...clone(exactRecord), op: 'remove' };
        delete record.value;
      }
      else {
        if (operation.value === undefined) throw new DomainError('E_PREFAB_OVERRIDE_VALUE', 'prefab override set requires --value or --remove', { exitCode: EXIT.USAGE });
        if (ownerPath && !readRelative(entity, ownerPath).exists) {
          const ownerSource = readRelative(source, ownerPath);
          if (ownerSource.exists) writeRelativeState(entity, ownerPath, ownerSource);
        }
        record = { ...clone(exactRecord), op: sourceState.exists ? 'replace' : 'add', value: clone(operation.value) };
        writeRelativeState(entity, path, { exists: true, value: operation.value });
        if (ownerPath) {
          record = rebaseOverrideRecord(source, entity, ownerPath, ownerRecord);
          if (record) overrides[ownerPath] = record;
          attachPrefabMarker(entity, { ...marker.value, overrides });
          return { sceneId: scene.id, prefabId: prefab.id, instanceRootId: marker.value.instanceRootId, entityId: entity.id, sourceEntityId: source.id, path, storedPath: ownerPath, override: record, reverted: record == null };
        }
      }
      overrides[path] = record;
      attachPrefabMarker(entity, { ...marker.value, overrides });
      return { sceneId: scene.id, prefabId: prefab.id, instanceRootId: marker.value.instanceRootId, entityId: entity.id, sourceEntityId: source.id, path, override: record };
    }
    if (op === 'prefab.override.apply') {
      const scene = operationScene(document, operation), entity = resolveEntity(scene, operation.entityId || operation.entity || operation.entityName, { allowName: operation.entityName != null });
      const selectedPath = operation.path == null ? null : normalizeOverridePath(operation.path);
      const inspected = overrideEntries(document, scene, entity, Boolean(operation.all));
      const entries = inspected.entries.filter(entry => selectedPath == null || entry.path === selectedPath);
      if (!entries.length) throw new DomainError('E_PREFAB_OVERRIDE_NOT_FOUND', 'No matching Prefab override was found', { exitCode: EXIT.NOT_FOUND, details: { entityId: entity.id, path: selectedPath } });
      const previousRevision = Number.isInteger(inspected.context.prefab.revision) ? inspected.context.prefab.revision : 0;
      let synchronizedEntityCount = 0;
      for (const entry of entries) {
        const member = inspected.context.group.members.find(item => item.entity.id === entry.entityId), currentMarker = prefabMarker(member.entity).value, source = sourceEntityForMarker(inspected.context.prefab, currentMarker);
        const sourceState = readRelative(source, entry.path), appliedOperation = normalizeOverrideRecord(entry.override, sourceState.exists);
        applyOverrideRecord(source, entry.path, appliedOperation, sourceState.exists);
        const overrides = clone(currentMarker.overrides || {});delete overrides[entry.path];
        attachPrefabMarker(member.entity, { ...currentMarker, overrides });
        synchronizedEntityCount += syncPrefabPath(document, inspected.context.prefab, source, entry.path, appliedOperation, {
          sceneId: scene.id, instanceRootId: inspected.context.group.rootId, entityId: member.entity.id
        }, previousRevision);
      }
      const currentGroups = new Map(instanceGroups(document, inspected.context.prefab.id).map(group => [
        `${group.scene.id}\u0000${group.prefabId}\u0000${group.rootId}`,
        group.members.every(member => member.marker.value.prefabRevision === previousRevision)
      ]));
      inspected.context.prefab.revision = previousRevision + 1;
      inspected.context.prefab.updatedAt = now();
      for (const group of instanceGroups(document, inspected.context.prefab.id)) for (const member of group.members) {
        const key = `${group.scene.id}\u0000${group.prefabId}\u0000${group.rootId}`;
        attachPrefabMarker(member.entity, {
          ...member.marker.value,
          prefabRevision: currentGroups.get(key) === true ? inspected.context.prefab.revision : member.marker.value.prefabRevision
        });
      }
      return { sceneId: scene.id, prefabId: inspected.context.prefab.id, instanceRootId: inspected.context.group.rootId, entityId: entity.id, appliedCount: entries.length, synchronizedEntityCount, paths: entries.map(entry => entry.path) };
    }
    if (op === 'prefab.override.revert') {
      const scene = operationScene(document, operation), entity = resolveEntity(scene, operation.entityId || operation.entity || operation.entityName, { allowName: operation.entityName != null });
      const selectedPath = operation.path == null ? null : normalizeOverridePath(operation.path);
      const inspected = overrideEntries(document, scene, entity, Boolean(operation.all));
      const entries = inspected.entries.filter(entry => selectedPath == null || entry.path === selectedPath);
      if (!entries.length) throw new DomainError('E_PREFAB_OVERRIDE_NOT_FOUND', 'No matching Prefab override was found', { exitCode: EXIT.NOT_FOUND, details: { entityId: entity.id, path: selectedPath } });
      for (const entry of entries) {
        const member = inspected.context.group.members.find(item => item.entity.id === entry.entityId), currentMarker = prefabMarker(member.entity).value, source = sourceEntityForMarker(inspected.context.prefab, currentMarker);
        revertOverrideRecord(source, member.entity, entry.path, entry.override);
        const overrides = clone(currentMarker.overrides || {});delete overrides[entry.path];
        attachPrefabMarker(member.entity, { ...currentMarker, overrides });
      }
      return { sceneId: scene.id, prefabId: inspected.context.prefab.id, instanceRootId: inspected.context.group.rootId, entityId: entity.id, revertedCount: entries.length, paths: entries.map(entry => entry.path) };
    }
    if (op === 'prefab.unpack') {
      const scene = operationScene(document, operation), entity = resolveEntity(scene, operation.entityId || operation.entity || operation.entityName, { allowName: operation.entityName != null }), context = instanceGroupForEntity(document, scene, entity);
      const { entityIds } = unpackPrefabGroup(document, context.group);
      return { sceneId: scene.id, prefabId: context.prefab.id, instanceRootId: context.group.rootId, entityIds, unpacked: true };
    }
  }
  if (op.startsWith('entity.')) {
    const scene = operationScene(document, operation);scene.objects = Array.isArray(scene.objects) ? scene.objects : [];
    const sceneIndex = buildSceneIndex(scene);
    if (op === 'entity.create') {
      const entity = defaultEntity(operation);if (scene.objects.some(item => item.id === entity.id)) throw new DomainError('E_ENTITY_EXISTS', `Entity already exists: ${entity.id}`, { exitCode: EXIT.CONFLICT });
      assertOrdinaryPrefabEntity(entity, 'create a connected Prefab member through entity.create', true);
      if (entity.parentId || operation.parentId) {
        const parent = resolveEntity(scene, operation.parentId || entity.parentId, { index: sceneIndex });
        assertOrdinaryPrefabEntity(parent, 'create a child inside a connected Prefab instance', true);
        entity.parentId = parent.id;
      }
      if (operation.layer == null && operation.entity?.layer == null) entity.layer = scene.objects.length ? Math.max(...scene.objects.map(item => finite(item.layer) ? Number(item.layer) : 0)) + 1 : 0;
      scene.objects.push(entity);return { sceneId: scene.id, entityId: entity.id, entity: clone(entity) };
    }
    const entity = resolveEntity(scene, operation.entityId || operation.id || operation.entityName, { allowName: operation.entityName != null, index: sceneIndex });
    if (op === 'entity.clone') {
      const include = operation.deep ? new Set([entity.id, ...descendants(scene, entity.id, sceneIndex)]) : new Set([entity.id]), originals = scene.objects.filter(item => include.has(item.id));
      assertNoConnectedPrefabMembers(originals, 'clone a connected Prefab member');
      const remapped = remapObjects(originals, { document, animationSuffix: 'Entity Copy' }).objects;
      const rootIndex = originals.findIndex(item => item.id === entity.id), rootCopy = remapped[rootIndex];renameEntityValue(rootCopy, operation.name || `${entityName(entity)} Copy`);offsetEntityValue(rootCopy, Number(operation.offsetX ?? 24), Number(operation.offsetY ?? 24));
      if (!operation.deep && entity.parentId) rootCopy.parentId = entity.parentId;scene.objects.push(...remapped);return { sceneId: scene.id, entityId: rootCopy.id, entityIds: remapped.map(item => item.id) };
    }
    if (op === 'entity.rename') { assertOrdinaryPrefabEntity(entity, 'rename this Entity', false);const name = renameEntityValue(entity, operation.name);return { sceneId: scene.id, entityId: entity.id, name }; }
    if (op === 'entity.patch') { assertOrdinaryPrefabEntity(entity, 'patch this Entity', false);const index = scene.objects.indexOf(entity), patch = requireObjectPatch(operation.patch, op);scene.objects[index] = mergePatch(entity, patch);scene.objects[index].id = entity.id;return { sceneId: scene.id, entityId: entity.id, entity: clone(scene.objects[index]) }; }
    if (op === 'entity.set') { assertPrefabPropertyMutation(entity, operation.path, 'set this property');setPath(entity, operation.path, operation.value);return { sceneId: scene.id, entityId: entity.id, path: operation.path, value: clone(operation.value) }; }
    if (op === 'entity.reparent') {
      const parentId = operation.parentId === null || operation.parentId === '' ? null : String(operation.parentId);
      const preserveWorld = operation.preserveWorld === true;
      if (preserveWorld && operation.preserveLocal === true) {
        throw new DomainError('E_REPARENT_TRANSFORM_MODE', 'Choose only one of preserveWorld or preserveLocal', { exitCode: EXIT.USAGE });
      }
      let parent = null;
      if (parentId) {
        parent = resolveEntity(scene, parentId, { index: sceneIndex });
        if (parentId === entity.id || descendants(scene, entity.id, sceneIndex).has(parentId)) throw new DomainError('E_PARENT_CYCLE', 'Reparent would create a cycle', { exitCode: EXIT.CONFLICT });
        assertOrdinaryPrefabEntity(parent, 'reparent an Entity inside a connected Prefab instance', true);
      }
      const marker = prefabMarker(entity);
      if (marker && String(entity.id) !== String(marker.value.instanceRootId)) throw prefabInstanceError(entity, marker, 'reparent a connected Prefab member', true);
      let nextLocal = null;
      if (preserveWorld) {
        const worldCache = new Map();
        const worldBefore = worldMatrixOf(scene, entity, worldCache, sceneIndex);
        const parentWorld = parent ? worldMatrixOf(scene, parent, worldCache, sceneIndex) : IDENTITY_MATRIX;
        nextLocal = decomposeMatrix(multiplyMatrices(invertMatrix(parentWorld, parentId), worldBefore), entity.id);
      }
      if (parentId) entity.parentId = parentId;
      else delete entity.parentId;
      const localTransform = nextLocal ? writeLocalTransform(entity, nextLocal) : localTransformOf(entity);
      const worldMatrix = worldMatrixOf(scene, entity, new Map(), sceneIndex);
      return { sceneId: scene.id, entityId: entity.id, parentId, transformMode: preserveWorld ? 'preserve-world' : 'preserve-local', localTransform, worldMatrix };
    }
    if (op === 'entity.delete') {
      assertOrdinaryPrefabEntity(entity, 'delete a connected Prefab member', true);
      const children = sceneIndex.childrenByParent.get(entity.id) || [];
      const preserveWorld = operation.preserveWorld === true;
      const preserveLocal = operation.preserveLocal === true;
      if (operation.cascade && operation.reparent) {
        throw new DomainError('E_DELETE_MODE', 'Choose only one of cascade or reparent when deleting an Entity', { exitCode: EXIT.USAGE });
      }
      if (preserveWorld && preserveLocal) {
        throw new DomainError('E_REPARENT_TRANSFORM_MODE', 'Choose only one of preserveWorld or preserveLocal', { exitCode: EXIT.USAGE });
      }
      if ((preserveWorld || preserveLocal) && !operation.reparent) {
        throw new DomainError('E_DELETE_TRANSFORM_MODE', 'Delete Transform mode requires reparenting the direct children', { exitCode: EXIT.USAGE });
      }
      if (children.length && !operation.cascade && !operation.reparent) throw new DomainError('E_ENTITY_HAS_CHILDREN', 'Entity has children; choose cascade or reparent', { exitCode: EXIT.CONFLICT, details: { children: children.map(item => item.id) } });
      const removed = operation.cascade ? new Set([entity.id, ...descendants(scene, entity.id, sceneIndex)]) : new Set([entity.id]);
      assertNoConnectedPrefabMembers(scene.objects.filter(item => removed.has(item.id)), 'delete a subtree containing connected Prefab members');
      let preparedTransforms = null;
      if (operation.reparent && preserveWorld) {
        const cache = new Map();
        const nextParent = entity.parentId ? resolveEntity(scene, entity.parentId, { index: sceneIndex }) : null;
        const nextParentWorld = nextParent ? worldMatrixOf(scene, nextParent, cache, sceneIndex) : IDENTITY_MATRIX;
        const inverseParentWorld = nextParent ? invertMatrix(nextParentWorld, nextParent.id) : IDENTITY_MATRIX;
        preparedTransforms = children.map(child => ({
          child,
          transform: decomposeMatrix(multiplyMatrices(inverseParentWorld, worldMatrixOf(scene, child, cache, sceneIndex)), child.id)
        }));
      }
      if (operation.reparent) {
        for (const child of children) { if (entity.parentId) child.parentId = entity.parentId;else delete child.parentId; }
        if (preparedTransforms) for (const prepared of preparedTransforms) writeLocalTransform(prepared.child, prepared.transform);
      }
      scene.objects = scene.objects.filter(item => !removed.has(item.id));
      return { sceneId: scene.id, entityIds: [...removed], deleted: true, transformMode: operation.reparent ? (preserveWorld ? 'preserve-world' : 'preserve-local') : null };
    }
  }
  if (op.startsWith('component.')) {
    const scene = operationScene(document, operation), entity = resolveEntity(scene, operation.entityId || operation.id || operation.entityName, { allowName: operation.entityName != null }), type = componentAlias(operation.component || operation.type);
    assertPrefabComponentMutation(entity, type, `${op} ${type}`);
    const pointer = componentValuePointer(document, scene, entity, type);
    if (op === 'component.put') {
      const value = putComponent(entity, type, operation.value, { pointer }), written = getComponent(entity, type);
      return { sceneId: scene.id, entityId: entity.id, component: type, storage: written.storage, provenance: written.provenance, value: clone(value) };
    }
    const component = getComponent(entity, type);
    if (component.value === undefined) throw new DomainError('E_COMPONENT_NOT_FOUND', `Component not found: ${type}`, { exitCode: EXIT.NOT_FOUND });
    if (op === 'component.patch') {
      const value = putComponent(entity, type, mergePatch(component.value, requireObjectPatch(operation.patch, op)), { pointer, provenance: component.provenance });
      const written = getComponent(entity, type);
      return { sceneId: scene.id, entityId: entity.id, component: type, storage: written.storage, provenance: written.provenance, value: clone(value) };
    }
    if (op === 'component.set') {
      const next = clone(component.value);setPath(next, operation.path, operation.value);
      const value = putComponent(entity, type, next, { pointer, provenance: component.provenance });
      const written = getComponent(entity, type);
      return { sceneId: scene.id, entityId: entity.id, component: type, storage: written.storage, provenance: written.provenance, value: clone(value) };
    }
    if (op === 'component.delete') return { sceneId: scene.id, entityId: entity.id, component: type, storage: component.storage, provenance: component.provenance, deleted: removeComponent(entity, type, { pointer, provenance: component.provenance }) };
  }
  if (op === 'runtime.set') {
    document.engine = isObject(document.engine) ? document.engine : {};
    const runtime = String(operation.runtime || '').toLowerCase();if (!RUNTIMES.has(runtime)) throw new DomainError('E_RUNTIME', `Unsupported runtime: ${runtime}`, { exitCode: EXIT.USAGE });document.engine.runtime = runtime;document.engine.renderer = runtime;return { runtime };
  }
  if (op === 'physics.set') {
    document.engine = isObject(document.engine) ? document.engine : {};
    document.engine.gravity = isObject(document.engine.gravity) ? document.engine.gravity : { x: 0, y: 980 };
    if (operation.backend != null) {
      const backend = String(operation.backend).toLowerCase();
      if (!PHYSICS_BACKENDS.has(backend)) throw new DomainError('E_PHYSICS_BACKEND', `Unsupported physics backend: ${operation.backend}`, { exitCode: EXIT.USAGE, pointer: '/engine/physics' });
      document.engine.physics = backend;
      document.engine.physicsBackend = backend;
      document.engine.physicsImplementation = PHYSICS_IMPLEMENTATIONS[backend];
    }
    if (operation.gravityX != null) document.engine.gravity.x = Number(operation.gravityX);if (operation.gravityY != null) document.engine.gravity.y = Number(operation.gravityY);if (operation.pixelsPerMeter != null) document.engine.pixelsPerMeter = Number(operation.pixelsPerMeter);
    const requested = String(document.engine.physics || 'box2d').toLowerCase();
    const backend = String(document.engine.physicsBackend || requested).toLowerCase();
    return { requested, backend, implementation: document.engine.physicsImplementation || PHYSICS_IMPLEMENTATIONS[backend], native: backend === 'box2d', gravity: clone(document.engine.gravity), pixelsPerMeter: document.engine.pixelsPerMeter };
  }
  if (op === 'project.patch') { const patched = mergePatch(document, requireObjectPatch(operation.patch, op));Object.keys(document).forEach(key => delete document[key]);Object.assign(document, patched);return { patched: true }; }
  if (op === 'resource.put' || op === 'resource.delete') {
    const field = resourceField(operation.resource || operation.type, document), list = document[field];
    if (op === 'resource.put') {
      const value = clone(operation.value);if (value === undefined) throw new DomainError('E_RESOURCE_VALUE', 'Resource value is required', { exitCode: EXIT.USAGE });
      if (typeof value === 'string') { if (!list.includes(value)) list.push(value);return { resource: field, value }; }
      if (!isObject(value)) throw new DomainError('E_RESOURCE_VALUE', 'Resource value must be a string or JSON object', { exitCode: EXIT.USAGE });
      const key = value.id || value.name;if (!key) throw new DomainError('E_RESOURCE_ID', 'Resource needs id or name', { exitCode: EXIT.USAGE });const index = list.findIndex(item => isObject(item) && (item.id === value.id || (!value.id && item.name === value.name)));if (index >= 0) list[index] = value;else list.push(value);return { resource: field, value };
    }
    const reference = String(operation.resourceId || operation.id || operation.name || '');const index = list.findIndex(item => String(isObject(item) ? (item.id || item.name) : item) === reference);if (index < 0) throw new DomainError('E_RESOURCE_NOT_FOUND', `Resource not found: ${reference}`, { exitCode: EXIT.NOT_FOUND });return { resource: field, value: list.splice(index, 1)[0], deleted: true };
  }
  throw new DomainError('E_OPERATION_UNKNOWN', `Unknown operation: ${operation.op}`, { exitCode: EXIT.USAGE });
}

function applyOperations(input, operations, options = {}) {
  const { document, dialect, migrated } = migrateDocument(input, options);
  if (!Array.isArray(operations) || !operations.length) throw new DomainError('E_OPERATIONS', 'At least one operation is required', { exitCode: EXIT.USAGE });
  const results = [];
  for (const operation of operations) results.push(applyOperationMutable(document, operation));
  syncActiveMirror(document);
  const diagnostics = options.skipValidation ? validateDocument(document, options) : assertValid(document, options);
  return { document, results, diagnostics, dialect, migrated };
}

function resourceField(type, document) {
  const key = String(type || '').toLowerCase();
  const fields = { asset: 'assets', assets: 'assets', folder: 'folders', folders: 'folders', prefab: Array.isArray(document.prefabs) ? 'prefabs' : 'prefab', prefabs: Array.isArray(document.prefabs) ? 'prefabs' : 'prefab', animation: 'animations', animations: 'animations', particle: 'particles', particles: 'particles', shader: 'shaderGraphs', shaders: 'shaderGraphs', shadergraph: 'shaderGraphs', shadergraphs: 'shaderGraphs' };
  const field = fields[key];if (!field) throw new DomainError('E_RESOURCE_TYPE', `Unknown resource type: ${type}`, { exitCode: EXIT.USAGE });if (!Array.isArray(document[field])) document[field] = [];return field;
}

function listComponents(entity) {
  return componentCall(() => entityCodec.list(entity, { clone: true })).map(component => ({
    type: component.type, storage: component.storage, provenance: component.provenance,
    conflicts: clone(component.conflicts)
  }));
}

function listEntities(scene, options = {}) {
  const sceneIndex = buildSceneIndex(scene), objects = sceneIndex.objects, byParent = sceneIndex.childrenByParent;
  const metadata = new Map(), visited = new Set(), ordered = [];
  const includePath = options.path !== false;
  const visit = (root, rootDepth, rootPath) => {
    const rootEntry = { entity: root, depth: rootDepth };
    if (includePath) rootEntry.parentPath = rootPath;
    const stack = [rootEntry];
    while (stack.length) {
      const entry = stack.pop();
      const { entity, depth } = entry;
      if (visited.has(entity.id)) continue;
      visited.add(entity.id);
      ordered.push(entity);
      const children = byParent.get(entity.id) || [];
      const nodeMetadata = { depth, childCount: children.length };
      let path;
      if (includePath) {
        path = [...entry.parentPath, entity.id];
        nodeMetadata.path = path;
      }
      metadata.set(entity.id, nodeMetadata);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const childEntry = { entity: children[index], depth: depth + 1 };
        if (includePath) childEntry.parentPath = path;
        stack.push(childEntry);
      }
    }
  };
  if (options.tree) {
    for (const root of byParent.get(null) || []) visit(root, 0, includePath ? [] : null);
    for (const entity of objects) if (!visited.has(entity.id)) visit(entity, 0, includePath ? [] : null);
  }
  let entities = options.tree ? ordered : objects;
  if (options.kind) entities = entities.filter(entity => String(entity.kind || '').toLowerCase() === String(options.kind).toLowerCase());
  if (options.component) entities = entities.filter(entity => getComponent(entity, options.component).value !== undefined);
  const worldCache = new Map();
  return entities.map(entity => {
    const output = { ...clone(entity), name: entityName(entity) };
    if (options.tree) Object.assign(output, metadata.get(entity.id));
    if (options.world) {
      output.localTransform = localTransformOf(entity);
      output.localMatrix = localMatrixOf(entity).map(cleanTransformNumber);
      output.worldMatrix = worldMatrixOf(scene, entity, worldCache, sceneIndex).map(cleanTransformNumber);
      output.worldPosition = { x: output.worldMatrix[4], y: output.worldMatrix[5] };
    }
    return output;
  });
}

function decodePointer(pointer) {
  if (pointer === '') return [];
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new DomainError('E_JSON_POINTER', `Invalid JSON pointer: ${pointer}`, { exitCode: EXIT.USAGE });
  const segments = pointer.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.some(segment => FORBIDDEN_KEYS.has(segment))) throw new DomainError('E_UNSAFE_PATH', 'Unsafe JSON pointer', { exitCode: EXIT.CONFLICT });
  return segments;
}

function getPointer(document, pointer) {
  let cursor = document;for (const segment of decodePointer(pointer)) { if (cursor == null || !Object.prototype.hasOwnProperty.call(cursor, segment)) throw new DomainError('E_POINTER_NOT_FOUND', `JSON pointer not found: ${pointer}`, { exitCode: EXIT.NOT_FOUND, pointer });cursor = cursor[segment]; }return cursor;
}

function pointerParent(document, pointer) {
  const segments = decodePointer(pointer);if (!segments.length) return { parent: null, key: null };const key = segments.pop();let parent = document;for (const segment of segments) { if ((!isObject(parent) && !Array.isArray(parent)) || !Object.prototype.hasOwnProperty.call(parent, segment)) throw new DomainError('E_POINTER_NOT_FOUND', `JSON pointer parent not found: ${pointer}`, { exitCode: EXIT.NOT_FOUND, pointer });parent = parent[segment]; }return { parent, key };
}

function applyJsonPatch(input, patch) {
  let document = clone(input);if (!Array.isArray(patch)) throw new DomainError('E_JSON_PATCH', 'JSON Patch must be an array', { exitCode: EXIT.USAGE });
  for (const operation of patch) {
    const op = String(operation?.op || '').toLowerCase(), path = operation?.path;
    if (op === 'test') { if (!equal(getPointer(document, path), operation.value)) throw new DomainError('E_PATCH_TEST', `JSON Patch test failed: ${path}`, { exitCode: EXIT.CONFLICT, pointer: path });continue; }
    if (op === 'copy' || op === 'move') { const value = clone(getPointer(document, operation.from));if (op === 'move') document = patchRemove(document, operation.from);document = patchSet(document, path, value, true);continue; }
    if (op === 'remove') { document = patchRemove(document, path);continue; }
    if (op === 'add') { document = patchSet(document, path, operation.value, true);continue; }
    if (op === 'replace') { getPointer(document, path);document = patchSet(document, path, operation.value, false);continue; }
    throw new DomainError('E_PATCH_OPERATION', `Unsupported JSON Patch operation: ${operation?.op}`, { exitCode: EXIT.USAGE });
  }
  return document;
}

function patchSet(document, pointer, value, add) {
  if (pointer === '') return clone(value);const { parent, key } = pointerParent(document, pointer);
  if (Array.isArray(parent)) { if (key === '-' && add) parent.push(clone(value));else { const index = Number(key);if (!Number.isInteger(index) || index < 0 || index > parent.length || (!add && index >= parent.length)) throw new DomainError('E_ARRAY_INDEX', `Invalid array index: ${key}`, { exitCode: EXIT.NOT_FOUND, pointer });if (add) parent.splice(index, 0, clone(value));else parent[index] = clone(value); } }
  else { if (!isObject(parent)) throw new DomainError('E_POINTER_PARENT', `JSON pointer parent is not an object: ${pointer}`, { exitCode: EXIT.VALIDATION, pointer });parent[key] = clone(value); }
  return document;
}

function patchRemove(document, pointer) {
  if (pointer === '') throw new DomainError('E_REMOVE_ROOT', 'Cannot remove the document root', { exitCode: EXIT.CONFLICT, pointer });const { parent, key } = pointerParent(document, pointer);
  if ((!isObject(parent) && !Array.isArray(parent)) || !Object.prototype.hasOwnProperty.call(parent, key)) throw new DomainError('E_POINTER_NOT_FOUND', `JSON pointer not found: ${pointer}`, { exitCode: EXIT.NOT_FOUND, pointer });if (Array.isArray(parent)) { const index = Number(key);if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new DomainError('E_ARRAY_INDEX', `Invalid array index: ${key}`, { exitCode: EXIT.NOT_FOUND, pointer });parent.splice(index, 1); } else delete parent[key];return document;
}

function documentHash(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = {
  PROTOCOL, PROJECT_VERSION, RUNTIMES, PHYSICS_BACKENDS, PHYSICS_IMPLEMENTATIONS, BODY_TYPES, COLLIDER_SHAPES, EXIT, DomainError,
  DATA_MODEL_DESCRIPTOR, COMPONENT_SCHEMA_PROFILES: PROFILE_NAMES, componentRegistry, entityCodec,
  PREFAB_ASSET_SCHEMA, ANIMATION_CLIP_SCHEMA, PARTICLE_ASSET_SCHEMA, SHADER_GRAPH_SCHEMA, POST_PROCESS_EFFECT_SCHEMA, POST_PROCESS_SCHEMA,
  SHADER_NODE_TYPES, SHADER_VALUE_TYPES, SHADER_NODE_DEFINITIONS,
  clone, generateId, detectDialect, createProject, createDefaultPostProcess, migrateDocument, syncActiveMirror,
  validateDocument, assertValid, resolveScene, resolveEntity, entityName,
  applyOperations, applyJsonPatch, mergePatch, setPath, getPointer,
  listComponents, listEntities, getComponent, putComponent, removeComponent, resourceField, documentHash, escapePointer,
  prefabAssets, resolvePrefab, inspectPrefabOverrides,
  localTransformOf, localMatrixOf, worldMatrixOf, multiplyMatrices, invertMatrix, decomposeMatrix,
  IDENTITY_MATRIX, TRANSFORM_EPSILON, TRANSFORM_TOLERANCE
};
