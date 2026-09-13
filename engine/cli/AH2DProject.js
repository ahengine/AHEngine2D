'use strict';

const crypto = require('crypto');

const PROTOCOL = 'ah2d.cli/v1';
const PROJECT_VERSION = 4;
const RUNTIMES = new Set(['pixijs', 'phaserjs', 'custom']);
const BODY_TYPES = new Set(['static', 'dynamic', 'kinematic']);
const COLLIDER_SHAPES = new Set(['rectangle', 'box', 'circle']);
const EXIT = Object.freeze({ OK: 0, USAGE: 2, IO: 3, VALIDATION: 4, NOT_FOUND: 5, CONFLICT: 6, ENGINE: 7, INTERNAL: 70 });
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_POST_PROCESS_EFFECTS = Object.freeze([
  { id: 'bloom', type: 'bloom', name: 'Bloom', enabled: false, intensity: 0.22, radius: 8, threshold: 0.72 },
  { id: 'vignette', type: 'vignette', name: 'Vignette', enabled: true, intensity: 0.24, softness: 0.68 },
  { id: 'color-adjust', type: 'colorAdjust', name: 'Color Adjust', enabled: true, brightness: 1, contrast: 1, saturation: 1, hue: 0 },
  { id: 'chromatic-aberration', type: 'chromaticAberration', name: 'Chromatic Aberration', enabled: false, amount: 3, intensity: 0.32 },
  { id: 'pixelate', type: 'pixelate', name: 'Pixelate', enabled: false, size: 4 },
  { id: 'crt', type: 'crt', name: 'CRT', enabled: false, scanlines: 0.18, noise: 0.04, curvature: 0.12 }
]);

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
  let entity = objects.find(item => String(item?.id) === target);
  if (!entity && options.allowName) {
    const matches = objects.filter(item => entityName(item).toLocaleLowerCase() === target.toLocaleLowerCase());
    if (matches.length > 1) throw new DomainError('E_AMBIGUOUS_ENTITY', `Entity name is ambiguous: ${target}`, { exitCode: EXIT.CONFLICT, details: { matches: matches.map(item => item.id) } });
    entity = matches[0];
  }
  if (!entity) throw new DomainError('E_ENTITY_NOT_FOUND', `Entity not found: ${target}`, { exitCode: EXIT.NOT_FOUND, details: { sceneId: scene.id, reference: target } });
  return entity;
}

function entityName(entity) {
  return String(entity?.name ?? entity?.components?.Name?.value ?? 'Game Object');
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
      if (typeof entity.id !== 'string' || !entity.id.trim()) diagnostics.push(diagnostic('error', 'E_ENTITY_ID', 'Entity id must be a non-empty string', `${pointer}/id`));
      else if (ids.has(entity.id)) diagnostics.push(diagnostic('error', 'E_DUPLICATE_ENTITY_ID', `Duplicate entity id: ${entity.id}`, `${pointer}/id`, { first: ids.get(entity.id) }));
      else { ids.set(entity.id, `${pointer}/id`); byId.set(entity.id, entity); }
      if (entity.id) {
        if (globalEntityIds.has(entity.id) && globalEntityIds.get(entity.id).sceneId !== scene.id) diagnostics.push(diagnostic(options.strict ? 'error' : 'warning', 'W_CROSS_SCENE_ENTITY_ID', `Entity id is reused across Scenes: ${entity.id}`, `${pointer}/id`, { first: globalEntityIds.get(entity.id) }));
        else globalEntityIds.set(entity.id, { sceneId: scene.id, pointer: `${pointer}/id` });
      }
      for (const key of ['x', 'y', 'w', 'h', 'rot', 'sx', 'sy', 'layer']) if (entity[key] != null && !finite(entity[key])) diagnostics.push(diagnostic('error', 'E_TRANSFORM_NUMBER', `${key} must be finite`, `${pointer}/${key}`));
      const flatTransform = ['x', 'y', 'rot', 'sx', 'sy'].some(key => entity[key] != null), ecsTransform = entity.components?.Transform;
      if (flatTransform && isObject(ecsTransform)) diagnostics.push(diagnostic('warning', 'W_TRANSFORM_DIALECT_CONFLICT', 'Entity contains both flat Transform fields and components.Transform', pointer));
      const rigidbody = entity.rigidbody || entity.rigidBody || entity.components?.Rigidbody || entity.components?.RigidBody;
      if (entity.rigidbody && (entity.components?.Rigidbody || entity.components?.RigidBody)) diagnostics.push(diagnostic('warning', 'W_RIGIDBODY_DIALECT_CONFLICT', 'Entity contains flat and ECS Rigidbody definitions', pointer));
      if (isObject(rigidbody)) validateRigidbody(rigidbody, `${pointer}/rigidbody`, diagnostics);
      const colliders = entity.collider || entity.components?.Collider;
      if (entity.collider && entity.components?.Collider) diagnostics.push(diagnostic('warning', 'W_COLLIDER_DIALECT_CONFLICT', 'Entity contains flat and ECS Collider definitions', pointer));
      const colliderList = Array.isArray(colliders) ? colliders : (Array.isArray(colliders?.colliders) ? colliders.colliders : (colliders ? [colliders] : []));
      colliderList.forEach((collider, index) => validateCollider(collider, `${pointer}/collider${colliderList.length > 1 ? `/${index}` : ''}`, diagnostics));
    });
    scene.objects.forEach((entity, entityIndex) => {
      if (!entity?.parentId) return;
      const pointer = `${base}/objects/${entityIndex}/parentId`;
      if (entity.parentId === entity.id) diagnostics.push(diagnostic('error', 'E_SELF_PARENT', 'Entity cannot parent itself', pointer));
      else if (!byId.has(entity.parentId)) diagnostics.push(diagnostic('error', 'E_DANGLING_PARENT', `Parent does not exist in this Scene: ${entity.parentId}`, pointer));
    });
    const visiting = new Set(), visited = new Set();
    const visit = id => {
      if (visiting.has(id)) { diagnostics.push(diagnostic('error', 'E_PARENT_CYCLE', `Parent cycle contains entity: ${id}`, ids.get(id) || base)); return; }
      if (visited.has(id)) return;
      visiting.add(id);const parent = byId.get(id)?.parentId;if (parent && byId.has(parent)) visit(parent);visiting.delete(id);visited.add(id);
    };
    byId.forEach((_, id) => visit(id));
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

function validateRigidbody(body, pointer, diagnostics) {
  if (body.type != null && !BODY_TYPES.has(String(body.type).toLowerCase())) diagnostics.push(diagnostic('error', 'E_BODY_TYPE', `Invalid Rigidbody type: ${body.type}`, `${pointer}/type`));
  for (const key of ['mass', 'gravityScale', 'linearDamping', 'angularDamping', 'velocityX', 'velocityY', 'angularVelocity']) if (body[key] != null && !finite(body[key])) diagnostics.push(diagnostic('error', 'E_BODY_NUMBER', `${key} must be finite`, `${pointer}/${key}`));
  if (body.mass != null && Number(body.mass) <= 0) diagnostics.push(diagnostic('error', 'E_BODY_MASS', 'mass must be greater than zero', `${pointer}/mass`));
  for (const key of ['linearDamping', 'angularDamping']) if (body[key] != null && Number(body[key]) < 0) diagnostics.push(diagnostic('error', 'E_BODY_DAMPING', `${key} cannot be negative`, `${pointer}/${key}`));
}

function validateCollider(collider, pointer, diagnostics) {
  if (!isObject(collider)) { diagnostics.push(diagnostic('error', 'E_COLLIDER_TYPE', 'Collider must be an object', pointer)); return; }
  if (collider.shape != null && !COLLIDER_SHAPES.has(String(collider.shape).toLowerCase())) diagnostics.push(diagnostic('error', 'E_COLLIDER_SHAPE', `Invalid Collider shape: ${collider.shape}`, `${pointer}/shape`));
  for (const key of ['width', 'height', 'radius', 'density']) if (collider[key] != null && (!finite(collider[key]) || Number(collider[key]) <= 0)) diagnostics.push(diagnostic('error', 'E_COLLIDER_SIZE', `${key} must be greater than zero`, `${pointer}/${key}`));
  for (const key of ['offsetX', 'offsetY', 'rotation', 'friction', 'restitution', 'categoryBits', 'maskBits', 'groupIndex']) if (collider[key] != null && !finite(collider[key])) diagnostics.push(diagnostic('error', 'E_COLLIDER_NUMBER', `${key} must be finite`, `${pointer}/${key}`));
  if (collider.friction != null && Number(collider.friction) < 0) diagnostics.push(diagnostic('error', 'E_COLLIDER_FRICTION', 'friction cannot be negative', `${pointer}/friction`));
  if (collider.restitution != null && (Number(collider.restitution) < 0 || Number(collider.restitution) > 1)) diagnostics.push(diagnostic('error', 'E_COLLIDER_RESTITUTION', 'restitution must be between 0 and 1', `${pointer}/restitution`));
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

function descendants(scene, rootId) {
  const found = new Set(), queue = [rootId];
  while (queue.length) { const parent = queue.shift();for (const entity of scene.objects) if (entity.parentId === parent && !found.has(entity.id)) { found.add(entity.id);queue.push(entity.id); } }
  return found;
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

const componentAlias = name => {
  const key = String(name || '').replace(/[\s_-]/g, '').toLowerCase();
  if (key === 'rigidbody' || key === 'body') return 'Rigidbody';
  if (key === 'collider' || key === 'boxcollider' || key === 'circlecollider') return 'Collider';
  if (key === 'transform') return 'Transform';
  if (key === 'name') return 'Name';
  return String(name || '').trim();
};

function assertSafeComponent(type) {
  if (!type || FORBIDDEN_KEYS.has(String(type).toLowerCase())) throw new DomainError('E_COMPONENT_NAME', `Unsafe or empty Component name: ${type || '(empty)'}`, { exitCode: EXIT.CONFLICT });
}

function defaultComponent(type, entity) {
  if (type === 'Rigidbody') return { enabled: true, type: 'dynamic', mass: 1, useAutoMass: false, gravityScale: 1, linearDamping: 0.08, angularDamping: 0.08, fixedRotation: false, bullet: false, allowSleep: true, sleeping: false, velocityX: 0, velocityY: 0, angularVelocity: 0 };
  if (type === 'Collider') return { enabled: true, shape: 'rectangle', width: Math.max(1, Math.abs(Number(entity.w) || 64)), height: Math.max(1, Math.abs(Number(entity.h) || 64)), radius: Math.max(1, Math.min(Math.abs(Number(entity.w) || 64), Math.abs(Number(entity.h) || 64)) / 2), offsetX: 0, offsetY: 0, rotation: 0, density: 1, friction: 0.35, restitution: 0.05, isTrigger: false, categoryBits: 1, maskBits: 65535, groupIndex: 0 };
  if (type === 'Transform') return { x: Number(entity.x) || 0, y: Number(entity.y) || 0, rotation: Number(entity.rot) || 0, scaleX: Number(entity.sx) || 1, scaleY: Number(entity.sy) || 1 };
  if (type === 'Name') return { value: entityName(entity) };
  return {};
}

function getComponent(entity, name, create = false) {
  const type = componentAlias(name);
  if (!type) throw new DomainError('E_COMPONENT_NAME', 'Component name is required', { exitCode: EXIT.USAGE });assertSafeComponent(type);
  if (type === 'Rigidbody') {
    if (entity.rigidbody !== undefined) return { type, value: entity.rigidbody, storage: 'rigidbody' };
    if (entity.rigidBody !== undefined) return { type, value: entity.rigidBody, storage: 'rigidBody' };
    const key = Object.keys(entity.components || {}).find(value => value.toLowerCase() === 'rigidbody');
    if (key) return { type: key, value: entity.components[key], storage: `components.${key}` };
    if (create) entity.rigidbody = defaultComponent(type, entity);
    return { type, value: entity.rigidbody, storage: 'rigidbody' };
  }
  if (type === 'Collider') {
    if (entity.collider !== undefined) return { type, value: entity.collider, storage: 'collider' };
    const key = Object.keys(entity.components || {}).find(value => value.toLowerCase() === 'collider');
    if (key) return { type: key, value: entity.components[key], storage: `components.${key}` };
    if (create) entity.collider = defaultComponent(type, entity);
    return { type, value: entity.collider, storage: 'collider' };
  }
  if (type === 'Transform') {
    const key = Object.keys(entity.components || {}).find(value => value.toLowerCase() === 'transform');
    if (key) return { type: key, value: entity.components[key], storage: `components.${key}` };
    return { type, value: defaultComponent(type, entity), storage: 'flat-transform' };
  }
  if (type === 'Name') {
    const key = Object.keys(entity.components || {}).find(value => value.toLowerCase() === 'name');
    if (key) return { type: key, value: entity.components[key], storage: `components.${key}` };
    return { type, value: { value: entityName(entity) }, storage: 'flat-name' };
  }
  entity.components = isObject(entity.components) ? entity.components : {};
  const existing = Object.keys(entity.components).find(key => key.toLowerCase() === type.toLowerCase()) || type;
  if (entity.components[existing] == null && create) entity.components[existing] = {};
  return { type: existing, value: entity.components[existing], storage: `components.${existing}` };
}

function putComponent(entity, name, value) {
  const type = componentAlias(name);assertSafeComponent(type);const next = value === undefined ? defaultComponent(type, entity) : clone(value);
  if (!isObject(next) && !Array.isArray(next)) throw new DomainError('E_COMPONENT_VALUE', 'Component value must be an object or array', { exitCode: EXIT.USAGE });
  const existing = getComponent(entity, type);
  if (existing.storage.startsWith('components.')) { entity.components[existing.type] = next; }
  else if (existing.storage === 'rigidBody') entity.rigidBody = next;
  else if (type === 'Rigidbody') entity.rigidbody = next;
  else if (type === 'Collider') entity.collider = next;
  else if (type === 'Transform') {
    entity.x = Number(next.x ?? entity.x ?? 0);entity.y = Number(next.y ?? entity.y ?? 0);entity.rot = Number(next.rotation ?? next.rot ?? entity.rot ?? 0);entity.sx = Number(next.scaleX ?? next.sx ?? entity.sx ?? 1);entity.sy = Number(next.scaleY ?? next.sy ?? entity.sy ?? 1);
  } else if (type === 'Name') entity.name = String(next.value ?? next.name ?? entityName(entity));
  else { entity.components = isObject(entity.components) ? entity.components : {};entity.components[type] = next; }
  return getComponent(entity, type).value;
}

function removeComponent(entity, name) {
  const requested = componentAlias(name), component = getComponent(entity, name);
  if (requested === 'Transform' || requested === 'Name') throw new DomainError('E_REQUIRED_COMPONENT', `${requested} cannot be removed`, { exitCode: EXIT.CONFLICT });
  if (component.storage === 'rigidbody') delete entity.rigidbody;
  else if (component.storage === 'collider') delete entity.collider;
  else if (component.storage === 'rigidBody') delete entity.rigidBody;
  else if (component.storage.startsWith('components.')) delete entity.components[component.type];
  return component.value !== undefined;
}

function renameEntityValue(entity, name) {
  const value = String(name || '').trim();if (!value) throw new DomainError('E_ENTITY_NAME', 'Entity name is required', { exitCode: EXIT.USAGE });
  if (!entity.components?.Name || Object.prototype.hasOwnProperty.call(entity, 'name')) entity.name = value;
  if (entity.components?.Name) entity.components.Name.value = value;
  return value;
}

function offsetEntityValue(entity, x, y) {
  const transform = entity.components?.Transform;
  const hasFlat = ['x', 'y', 'rot', 'sx', 'sy'].some(key => Object.prototype.hasOwnProperty.call(entity, key));
  if (transform && !hasFlat) { transform.x = Number(transform.x || 0) + x;transform.y = Number(transform.y || 0) + y; }
  else { entity.x = Number(entity.x || 0) + x;entity.y = Number(entity.y || 0) + y; }
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
    if (op === 'entity.create') {
      const entity = defaultEntity(operation);if (scene.objects.some(item => item.id === entity.id)) throw new DomainError('E_ENTITY_EXISTS', `Entity already exists: ${entity.id}`, { exitCode: EXIT.CONFLICT });
      if (operation.parentId) { const parent = resolveEntity(scene, operation.parentId);entity.parentId = parent.id; }
      if (operation.layer == null && operation.entity?.layer == null) entity.layer = scene.objects.length ? Math.max(...scene.objects.map(item => finite(item.layer) ? Number(item.layer) : 0)) + 1 : 0;
      scene.objects.push(entity);return { sceneId: scene.id, entityId: entity.id, entity: clone(entity) };
    }
    const entity = resolveEntity(scene, operation.entityId || operation.id || operation.entityName, { allowName: operation.entityName != null });
    if (op === 'entity.clone') {
      const include = operation.deep ? new Set([entity.id, ...descendants(scene, entity.id)]) : new Set([entity.id]), originals = scene.objects.filter(item => include.has(item.id)), remapped = remapObjects(originals);
      const rootIndex = originals.findIndex(item => item.id === entity.id), rootCopy = remapped[rootIndex];renameEntityValue(rootCopy, operation.name || `${entityName(entity)} Copy`);offsetEntityValue(rootCopy, Number(operation.offsetX ?? 24), Number(operation.offsetY ?? 24));
      if (!operation.deep && entity.parentId) rootCopy.parentId = entity.parentId;scene.objects.push(...remapped);return { sceneId: scene.id, entityId: rootCopy.id, entityIds: remapped.map(item => item.id) };
    }
    if (op === 'entity.rename') { const name = renameEntityValue(entity, operation.name);return { sceneId: scene.id, entityId: entity.id, name }; }
    if (op === 'entity.patch') { const index = scene.objects.indexOf(entity), patch = requireObjectPatch(operation.patch, op);scene.objects[index] = mergePatch(entity, patch);scene.objects[index].id = entity.id;return { sceneId: scene.id, entityId: entity.id, entity: clone(scene.objects[index]) }; }
    if (op === 'entity.set') { setPath(entity, operation.path, operation.value);return { sceneId: scene.id, entityId: entity.id, path: operation.path, value: clone(operation.value) }; }
    if (op === 'entity.reparent') {
      const parentId = operation.parentId === null || operation.parentId === '' ? null : String(operation.parentId);
      if (parentId) { resolveEntity(scene, parentId);if (parentId === entity.id || descendants(scene, entity.id).has(parentId)) throw new DomainError('E_PARENT_CYCLE', 'Reparent would create a cycle', { exitCode: EXIT.CONFLICT });entity.parentId = parentId; } else delete entity.parentId;
      return { sceneId: scene.id, entityId: entity.id, parentId };
    }
    if (op === 'entity.delete') {
      const children = scene.objects.filter(item => item.parentId === entity.id);
      if (children.length && !operation.cascade && !operation.reparent) throw new DomainError('E_ENTITY_HAS_CHILDREN', 'Entity has children; choose cascade or reparent', { exitCode: EXIT.CONFLICT, details: { children: children.map(item => item.id) } });
      const removed = operation.cascade ? new Set([entity.id, ...descendants(scene, entity.id)]) : new Set([entity.id]);
      if (operation.reparent) for (const child of children) { if (entity.parentId) child.parentId = entity.parentId;else delete child.parentId; }
      scene.objects = scene.objects.filter(item => !removed.has(item.id));return { sceneId: scene.id, entityIds: [...removed], deleted: true };
    }
  }
  if (op.startsWith('component.')) {
    const scene = operationScene(document, operation), entity = resolveEntity(scene, operation.entityId || operation.id || operation.entityName, { allowName: operation.entityName != null }), type = componentAlias(operation.component || operation.type);
    if (op === 'component.put') return { sceneId: scene.id, entityId: entity.id, component: type, value: clone(putComponent(entity, type, operation.value)) };
    const component = getComponent(entity, type);
    if (component.value === undefined) throw new DomainError('E_COMPONENT_NOT_FOUND', `Component not found: ${type}`, { exitCode: EXIT.NOT_FOUND });
    if (op === 'component.patch') return { sceneId: scene.id, entityId: entity.id, component: type, value: clone(putComponent(entity, type, mergePatch(component.value, requireObjectPatch(operation.patch, op)))) };
    if (op === 'component.set') { const next = clone(component.value);setPath(next, operation.path, operation.value);return { sceneId: scene.id, entityId: entity.id, component: type, value: clone(putComponent(entity, type, next)) }; }
    if (op === 'component.delete') return { sceneId: scene.id, entityId: entity.id, component: type, deleted: removeComponent(entity, type) };
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
  const result = [{ type: 'Name', storage: 'flat-name' }, { type: 'Transform', storage: 'flat-transform' }];
  if (entity.rigidbody || entity.rigidBody) result.push({ type: 'Rigidbody', storage: entity.rigidbody ? 'rigidbody' : 'rigidBody' });
  if (entity.collider) result.push({ type: 'Collider', storage: 'collider' });
  for (const type of Object.keys(entity.components || {})) if (!result.some(item => item.type.toLowerCase() === type.toLowerCase())) result.push({ type, storage: `components.${type}` });
  return result;
}

function listEntities(scene, options = {}) {
  let entities = scene.objects.map(entity => ({ ...clone(entity), name: entityName(entity) }));
  if (options.kind) entities = entities.filter(entity => String(entity.kind || '').toLowerCase() === String(options.kind).toLowerCase());
  if (options.component) entities = entities.filter(entity => getComponent(entity, options.component).value !== undefined);
  if (options.tree) {
    const byParent = new Map();for (const entity of entities) { const parent = entity.parentId || null;const list = byParent.get(parent) || [];list.push(entity);byParent.set(parent, list); }
    const output = [], visit = (entity, depth) => { output.push({ ...entity, depth });for (const child of byParent.get(entity.id) || []) visit(child, depth + 1); };
    for (const root of byParent.get(null) || []) visit(root, 0);entities = output;
  }
  return entities;
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
  clone, generateId, detectDialect, createProject, createDefaultPostProcess, migrateDocument, syncActiveMirror,
  validateDocument, assertValid, resolveScene, resolveEntity, entityName,
  applyOperations, applyJsonPatch, mergePatch, setPath, getPointer,
  listComponents, listEntities, getComponent, resourceField, documentHash, escapePointer
};
