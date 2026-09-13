'use strict';

const crypto = require('crypto');
const {
  DATA_MODEL_ID, DATA_MODEL_VERSION, COMPONENT_SCHEMA_VERSION, PROFILE_NAMES,
  ComponentSchemaError, EntityCodec, createDefaultComponentRegistry
} = require('../AH2DDataModel.js');

const PROTOCOL = 'ah2d.cli/v1';
const PROJECT_VERSION = 4;
const RUNTIMES = new Set(['pixijs', 'phaserjs', 'custom']);
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
      physics: 'box2d', physicsBackend: 'builtin',
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
    prefab: [], animations: [], particles: []
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
      physics: 'box2d', physicsBackend: 'builtin', gravity: { x: 0, y: 980 }, pixelsPerMeter: 100,
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
  document.prefab = Array.isArray(document.prefab) ? document.prefab : [];
  document.animations = Array.isArray(document.animations) ? document.animations : [];
  document.particles = Array.isArray(document.particles) ? document.particles : [];
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
  const gravity = document.engine?.gravity;
  if (gravity && (!finite(gravity.x) || !finite(gravity.y))) diagnostics.push(diagnostic('error', 'E_GRAVITY', 'Gravity x and y must be finite', '/engine/gravity'));
  if (document.engine?.pixelsPerMeter != null && (!finite(document.engine.pixelsPerMeter) || Number(document.engine.pixelsPerMeter) <= 0)) diagnostics.push(diagnostic('error', 'E_PIXELS_PER_METER', 'pixelsPerMeter must be greater than zero', '/engine/pixelsPerMeter'));
  if (document.postProcess != null) {
    if (!isObject(document.postProcess)) diagnostics.push(diagnostic('error', 'E_POST_PROCESS_TYPE', 'postProcess must be an object', '/postProcess'));
    else {
      if (document.postProcess.enabled != null && typeof document.postProcess.enabled !== 'boolean') diagnostics.push(diagnostic('error', 'E_POST_PROCESS_ENABLED', 'postProcess.enabled must be boolean', '/postProcess/enabled'));
      if (!Array.isArray(document.postProcess.effects)) diagnostics.push(diagnostic('error', 'E_POST_PROCESS_EFFECTS', 'postProcess.effects must be an array', '/postProcess/effects'));
      else {
        const effectIds = new Set();
        document.postProcess.effects.forEach((effect, index) => {
          const pointer = `/postProcess/effects/${index}`;
          if (!isObject(effect)) { diagnostics.push(diagnostic('error', 'E_POST_PROCESS_EFFECT_TYPE', 'Post Process effect must be an object', pointer)); return; }
          if (typeof effect.id !== 'string' || !effect.id.trim()) diagnostics.push(diagnostic('error', 'E_POST_PROCESS_EFFECT_ID', 'Post Process effect id must be a non-empty string', `${pointer}/id`));
          else if (effectIds.has(effect.id)) diagnostics.push(diagnostic('error', 'E_POST_PROCESS_DUPLICATE_ID', `Duplicate Post Process effect id: ${effect.id}`, `${pointer}/id`));
          else effectIds.add(effect.id);
          if (typeof effect.type !== 'string' || !effect.type.trim()) diagnostics.push(diagnostic('error', 'E_POST_PROCESS_EFFECT_KIND', 'Post Process effect type must be a non-empty string', `${pointer}/type`));
          if (effect.enabled != null && typeof effect.enabled !== 'boolean') diagnostics.push(diagnostic('error', 'E_POST_PROCESS_EFFECT_ENABLED', 'Effect enabled must be boolean', `${pointer}/enabled`));
          for (const [key, value] of Object.entries(effect)) if (!['id', 'type', 'name', 'enabled'].includes(key) && typeof value === 'number' && !Number.isFinite(value)) diagnostics.push(diagnostic('error', 'E_POST_PROCESS_NUMBER', `${key} must be finite`, `${pointer}/${escapePointer(key)}`));
        });
      }
    }
  }
  for (const key of ['assets', 'folders', 'prefab', 'animations', 'particles']) if (document[key] != null && !Array.isArray(document[key])) diagnostics.push(diagnostic('error', 'E_RESOURCE_ARRAY', `${key} must be an array`, `/${key}`));
  return diagnostics;
}

function assertValid(document, options = {}) {
  const diagnostics = validateDocument(document, options);
  const failures = diagnostics.filter(item => item.severity === 'error' || (options.warningsAsErrors && item.severity === 'warning'));
  if (failures.length) throw new DomainError('E_PROJECT_INVALID', `Project validation failed with ${failures.length} issue${failures.length === 1 ? '' : 's'}`, { exitCode: EXIT.VALIDATION, details: { diagnostics } });
  return diagnostics;
}

function remapObjects(objects) {
  const ids = new Map();
  for (const entity of objects) if (entity?.id) ids.set(entity.id, generateId('entity'));
  return objects.map(entity => {
    const next = clone(entity);if (next.id) next.id = ids.get(next.id);if (next.parentId && ids.has(next.parentId)) next.parentId = ids.get(next.parentId);return next;
  });
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
    const scene = { ...clone(source), id, name: String(operation.name || `${source.name} Copy`), objects: operation.keepIds ? clone(source.objects) : remapObjects(source.objects), updatedAt: now() };
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
  if (op.startsWith('entity.')) {
    const scene = operationScene(document, operation);scene.objects = Array.isArray(scene.objects) ? scene.objects : [];
    const sceneIndex = buildSceneIndex(scene);
    if (op === 'entity.create') {
      const entity = defaultEntity(operation);if (scene.objects.some(item => item.id === entity.id)) throw new DomainError('E_ENTITY_EXISTS', `Entity already exists: ${entity.id}`, { exitCode: EXIT.CONFLICT });
      if (operation.parentId) { const parent = resolveEntity(scene, operation.parentId, { index: sceneIndex });entity.parentId = parent.id; }
      if (operation.layer == null && operation.entity?.layer == null) entity.layer = scene.objects.length ? Math.max(...scene.objects.map(item => finite(item.layer) ? Number(item.layer) : 0)) + 1 : 0;
      scene.objects.push(entity);return { sceneId: scene.id, entityId: entity.id, entity: clone(entity) };
    }
    const entity = resolveEntity(scene, operation.entityId || operation.id || operation.entityName, { allowName: operation.entityName != null, index: sceneIndex });
    if (op === 'entity.clone') {
      const include = operation.deep ? new Set([entity.id, ...descendants(scene, entity.id, sceneIndex)]) : new Set([entity.id]), originals = scene.objects.filter(item => include.has(item.id)), remapped = remapObjects(originals);
      const rootIndex = originals.findIndex(item => item.id === entity.id), rootCopy = remapped[rootIndex];renameEntityValue(rootCopy, operation.name || `${entityName(entity)} Copy`);offsetEntityValue(rootCopy, Number(operation.offsetX ?? 24), Number(operation.offsetY ?? 24));
      if (!operation.deep && entity.parentId) rootCopy.parentId = entity.parentId;scene.objects.push(...remapped);return { sceneId: scene.id, entityId: rootCopy.id, entityIds: remapped.map(item => item.id) };
    }
    if (op === 'entity.rename') { const name = renameEntityValue(entity, operation.name);return { sceneId: scene.id, entityId: entity.id, name }; }
    if (op === 'entity.patch') { const index = scene.objects.indexOf(entity), patch = requireObjectPatch(operation.patch, op);scene.objects[index] = mergePatch(entity, patch);scene.objects[index].id = entity.id;return { sceneId: scene.id, entityId: entity.id, entity: clone(scene.objects[index]) }; }
    if (op === 'entity.set') { setPath(entity, operation.path, operation.value);return { sceneId: scene.id, entityId: entity.id, path: operation.path, value: clone(operation.value) }; }
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
      }
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
    if (operation.gravityX != null) document.engine.gravity.x = Number(operation.gravityX);if (operation.gravityY != null) document.engine.gravity.y = Number(operation.gravityY);if (operation.pixelsPerMeter != null) document.engine.pixelsPerMeter = Number(operation.pixelsPerMeter);
    return { gravity: clone(document.engine.gravity), pixelsPerMeter: document.engine.pixelsPerMeter };
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
  const fields = { asset: 'assets', assets: 'assets', folder: 'folders', folders: 'folders', prefab: Array.isArray(document.prefabs) ? 'prefabs' : 'prefab', prefabs: Array.isArray(document.prefabs) ? 'prefabs' : 'prefab', animation: 'animations', animations: 'animations', particle: 'particles', particles: 'particles' };
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
  PROTOCOL, PROJECT_VERSION, RUNTIMES, BODY_TYPES, COLLIDER_SHAPES, EXIT, DomainError,
  DATA_MODEL_DESCRIPTOR, COMPONENT_SCHEMA_PROFILES: PROFILE_NAMES, componentRegistry, entityCodec,
  clone, generateId, detectDialect, createProject, createDefaultPostProcess, migrateDocument, syncActiveMirror,
  validateDocument, assertValid, resolveScene, resolveEntity, entityName,
  applyOperations, applyJsonPatch, mergePatch, setPath, getPointer,
  listComponents, listEntities, getComponent, putComponent, removeComponent, resourceField, documentHash, escapePointer,
  localTransformOf, localMatrixOf, worldMatrixOf, multiplyMatrices, invertMatrix, decomposeMatrix,
  IDENTITY_MATRIX, TRANSFORM_EPSILON, TRANSFORM_TOLERANCE
};
