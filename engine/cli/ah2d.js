#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  PROTOCOL, PROJECT_VERSION, PHYSICS_BACKENDS, PHYSICS_IMPLEMENTATIONS, EXIT, DomainError, clone, detectDialect, createProject,
  DATA_MODEL_DESCRIPTOR, COMPONENT_SCHEMA_PROFILES, PREFAB_ASSET_SCHEMA, ANIMATION_CLIP_SCHEMA, PARTICLE_ASSET_SCHEMA, componentRegistry,
  migrateDocument, syncActiveMirror, validateDocument, assertValid, resolveScene,
  resolveEntity, entityName, applyOperations, applyJsonPatch, mergePatch, getPointer,
  listComponents, listEntities, getComponent, putComponent, resourceField, documentHash,
  prefabAssets, resolvePrefab, inspectPrefabOverrides
} = require('./AH2DProject.js');

const CLI_VERSION = '0.3.0';
const DEFAULT_FILE = 'ah2d.project.json';
const BOOLEAN_OPTIONS = new Set([
  'help', 'version', 'json', 'pretty', 'write', 'dry-run', 'print-document', 'force',
  'activate', 'keep-ids', 'deep', 'cascade', 'reparent', 'strict', 'warnings-as-errors',
  'allow-invalid', 'fix', 'check', 'commit', 'tree', 'engine', 'backup', 'mkdir',
  'string', 'quiet', 'include-document', 'allow-future', 'include-stack', 'root',
  'world', 'preserve-world', 'preserve-local', 'all', 'remove', 'unpack-instances'
]);
const SHORT_OPTIONS = { f: 'file', o: 'out', j: 'json', h: 'help', w: 'write', n: 'dry-run' };

function parseArgs(argv) {
  const positionals = [], options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') { positionals.push(...argv.slice(index + 1));break; }
    if (argument.startsWith('--no-')) { options[argument.slice(5)] = false;continue; }
    if (argument.startsWith('--')) {
      const equalIndex = argument.indexOf('='), name = argument.slice(2, equalIndex < 0 ? undefined : equalIndex), inline = equalIndex < 0 ? undefined : argument.slice(equalIndex + 1);
      if (BOOLEAN_OPTIONS.has(name)) options[name] = inline === undefined ? true : inline !== 'false';
      else if (inline !== undefined) options[name] = inline;
      else if (index + 1 < argv.length) options[name] = argv[++index];
      else throw new DomainError('E_OPTION_VALUE', `Option requires a value: --${name}`, { exitCode: EXIT.USAGE });
      continue;
    }
    if (/^-[a-zA-Z]$/.test(argument)) {
      const name = SHORT_OPTIONS[argument[1]];if (!name) throw new DomainError('E_OPTION', `Unknown option: ${argument}`, { exitCode: EXIT.USAGE });
      if (BOOLEAN_OPTIONS.has(name)) options[name] = true;
      else if (index + 1 < argv.length) options[name] = argv[++index];
      else throw new DomainError('E_OPTION_VALUE', `Option requires a value: ${argument}`, { exitCode: EXIT.USAGE });
      continue;
    }
    positionals.push(argument);
  }
  if (options.json) options.format = 'json';
  return { positionals, options };
}

function readJsonText(text, label = 'JSON') {
  try { return JSON.parse(text); }
  catch (error) { throw new DomainError('E_JSON_PARSE', `${label} is not valid JSON: ${error.message}`, { exitCode: EXIT.IO, details: { label } }); }
}

function readValue(value, options = {}, io = process) {
  if (value === undefined) return undefined;
  const text = String(value);
  if (text === '-') return readJsonText(fs.readFileSync(0, 'utf8'), 'stdin');
  if (text.startsWith('@')) {
    const file = path.resolve(options.cwd || process.cwd(), text.slice(1));
    try { return readJsonText(fs.readFileSync(file, 'utf8'), file); }
    catch (error) { if (error instanceof DomainError) throw error;throw ioError(error, file); }
  }
  if (options.string) return text;
  try { return JSON.parse(text); } catch { return text; }
}

function requiredValue(value, message) {
  if (value === undefined || value === null || value === '') {
    throw new DomainError('E_REQUIRED_VALUE', message, { exitCode: EXIT.USAGE });
  }
  return value;
}

function ioError(error, file) {
  return new DomainError('E_IO', `${error.code || 'I/O error'}: ${file}`, { exitCode: EXIT.IO, details: { file, systemCode: error.code, message: error.message } });
}

function resolveFile(value, cwd = process.cwd()) {
  if (value === '-') return '-';
  return path.resolve(cwd, value || DEFAULT_FILE);
}

function readProject(file, io = process) {
  const target = resolveFile(file);
  try {
    const raw = target === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(target, 'utf8');
    return { file: target, raw, hash: documentHash(raw), document: readJsonText(raw, target) };
  } catch (error) { if (error instanceof DomainError) throw error;throw ioError(error, target); }
}

function jsonText(document, pretty = true) {
  return `${JSON.stringify(document, null, pretty ? 2 : 0)}\n`;
}

function writeAtomic(target, content, options = {}) {
  const directory = path.dirname(target);
  try {
    if (options.mkdir) fs.mkdirSync(directory, { recursive: true });
    if (options.backup && fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`);
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(temporary, content, 'utf8');
    try { fs.renameSync(temporary, target); }
    catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code) || !fs.existsSync(target)) { try { fs.unlinkSync(temporary); } catch {}throw error; }
      const displaced = `${temporary}.previous`;
      fs.renameSync(target, displaced);
      try { fs.renameSync(temporary, target);fs.unlinkSync(displaced); }
      catch (replacementError) { try { if (!fs.existsSync(target)) fs.renameSync(displaced, target); } catch {}throw replacementError; }
    }
  } catch (error) { throw ioError(error, target); }
}

function verifyExpectedHash(context, options) {
  const expected = options['expect-sha256'];
  if (!expected) return;
  const normalized = String(expected).toLowerCase();
  if (normalized !== context.hash.toLowerCase()) throw new DomainError('E_HASH_MISMATCH', 'Project changed since the Agent read it', { exitCode: EXIT.CONFLICT, details: { expected: normalized, actual: context.hash } });
  if (context.file !== '-') {
    let currentHash;
    try { currentHash = documentHash(fs.readFileSync(context.file)); } catch (error) { throw ioError(error, context.file); }
    if (currentHash !== normalized) throw new DomainError('E_HASH_MISMATCH', 'Project changed while the command was running', { exitCode: EXIT.CONFLICT, details: { expected: normalized, actual: currentHash } });
  }
}

function mutationMode(context, document, options, result = {}) {
  verifyExpectedHash(context, options);
  const outputFile = options.out ? resolveFile(options.out) : (options.write ? context.file : null);
  const dryRun = Boolean(options['dry-run']);
  if (!dryRun && !outputFile && !options['print-document']) throw new DomainError('E_WRITE_MODE', 'Mutation requires --write, --out, --print-document, or --dry-run', { exitCode: EXIT.USAGE });
  if (outputFile === '-') throw new DomainError('E_STDOUT_FILE', 'Use --print-document instead of --out -', { exitCode: EXIT.USAGE });
  if (outputFile && context.file === '-' && !options.out) throw new DomainError('E_STDIN_WRITE', 'stdin projects require --out or --print-document', { exitCode: EXIT.USAGE });
  const content = jsonText(document, options.pretty !== false), after = documentHash(content);
  if (outputFile && !dryRun) writeAtomic(outputFile, content, options);
  return {
    ...result, changed: context.raw.trim() !== content.trim(), dryRun,
    written: Boolean(outputFile && !dryRun), file: outputFile || context.file,
    sha256Before: context.hash, sha256After: after,
    ...(options['print-document'] || (dryRun && options['include-document']) ? { document } : {})
  };
}

function initProject(args) {
  const file = resolveFile(args.options.file || args.positionals[0]);
  if (file === '-') throw new DomainError('E_INIT_STDOUT', 'Use --print-document for stdout initialization', { exitCode: EXIT.USAGE });
  if (fs.existsSync(file) && !args.options.force && !args.options['dry-run'] && !args.options['print-document']) throw new DomainError('E_FILE_EXISTS', `File already exists: ${file}`, { exitCode: EXIT.CONFLICT, details: { file } });
  const document = createProject({ name: args.options.name, sceneName: args.options['scene-name'], sceneId: args.options['scene-id'], runtime: args.options.runtime });
  assertValid(document);
  const content = jsonText(document), hash = documentHash(content), dryRun = Boolean(args.options['dry-run']);
  if (!dryRun && !args.options['print-document']) writeAtomic(file, content, args.options);
  return { command: 'project.init', data: { file, changed: true, created: !dryRun && !args.options['print-document'], dryRun, sha256: hash, sceneId: document.currentSceneId, ...(args.options['print-document'] || (dryRun && args.options['include-document']) ? { document } : {}) } };
}

function sceneSelector(options) {
  if (options['scene-name'] != null) return { scene: options['scene-name'], sceneName: true };
  return { sceneId: options.scene || options['scene-id'] };
}

function entitySelector(options, positional) {
  if (options['entity-name'] != null) return { entityId: options['entity-name'], entityName: true };
  return { entityId: options.entity || options['entity-id'] || positional };
}

function operationResult(context, operations, options, command) {
  const applied = applyOperations(context.document, operations, { strict: options.strict, warningsAsErrors: options['warnings-as-errors'], skipValidation: options['allow-invalid'], allowFuture: options['allow-future'] });
  const data = mutationMode(context, applied.document, options, { results: applied.results, migrated: applied.migrated, sourceDialect: applied.dialect });
  return { command, data, diagnostics: applied.diagnostics };
}

function loadEngine() {
  try {
    if (!global.window) global.window = global;
    if (!global.AH2D) require(path.join(__dirname, '..', 'AH2DEngine.js'));
    if (!global.AH2D?.Engine) throw new Error('AH2D.Engine was not exported');
    return global.AH2D;
  } catch (error) { throw new DomainError('E_ENGINE_LOAD', `Unable to load AH2D Engine: ${error.message}`, { exitCode: EXIT.ENGINE, details: { enginePath: path.join(__dirname, '..', 'AH2DEngine.js') } }); }
}

function normalizePhysicsBackend(value, source = '--backend') {
  const backend = String(value == null ? 'box2d' : value).toLowerCase();
  if (!PHYSICS_BACKENDS.has(backend)) {
    throw new DomainError('E_PHYSICS_BACKEND', `Unsupported physics backend: ${value}`, {
      exitCode: EXIT.USAGE,
      details: { source, allowed: [...PHYSICS_BACKENDS] }
    });
  }
  return backend;
}

function configuredPhysics(document) {
  const requested = String(document?.engine?.physics == null ? 'box2d' : document.engine.physics).toLowerCase();
  const configuredBackend = document?.engine?.physicsBackend == null
    ? requested
    : String(document.engine.physicsBackend).toLowerCase();
  return {
    requested,
    backend: configuredBackend,
    implementation: document?.engine?.physicsImplementation ?? PHYSICS_IMPLEMENTATIONS[configuredBackend] ?? null,
    native: configuredBackend === 'box2d'
  };
}

function createPhysicsEngine(AH2D, document, options = {}) {
  const hasOverride = options.backend != null;
  const requested = normalizePhysicsBackend(options.backend ?? document?.engine?.physics ?? 'box2d', hasOverride ? '--backend' : '/engine/physics');
  const physicsOptions = {
    gravity: document?.engine?.gravity || { x: 0, y: 980 },
    pixelsPerMeter: Number(document?.engine?.pixelsPerMeter) || 100,
    ...(options.physicsOptions || {})
  };
  const adapter = requested === 'builtin'
    ? new AH2D.PhysicsAdapter(physicsOptions)
    : new AH2D.Box2DPhysicsAdapter(require('planck'), physicsOptions);
  const engine = new AH2D.Engine({ physics: adapter });
  const backend = normalizePhysicsBackend(adapter.backend || 'builtin', 'runtime adapter');
  return {
    engine,
    physics: {
      requested,
      backend,
      implementation: PHYSICS_IMPLEMENTATIONS[backend],
      native: backend === 'box2d'
    }
  };
}

function validateWithEngine(document, options = {}) {
  const AH2D = loadEngine(), diagnostics = [], executions = [];
  const backend = options.backend == null ? undefined : normalizePhysicsBackend(options.backend);
  for (const scene of document.scenes || []) {
    try {
      const { engine, physics } = createPhysicsEngine(AH2D, document, { backend });
      engine.load(document, { sceneId: scene.id });
      engine.update(0);
      executions.push({ sceneId: scene.id, ...physics });
    } catch (error) { diagnostics.push({ severity: 'error', code: 'E_ENGINE_LOAD', message: error.message, pointer: `/scenes/${document.scenes.indexOf(scene)}`, details: { sceneId: scene.id } }); }
  }
  return { diagnostics, executions };
}

function validateCommand(context, options) {
  if (options.fix) {
    const migrated = migrateDocument(context.document, { allowFuture: options['allow-future'] });syncActiveMirror(migrated.document);
    let diagnostics = validateDocument(migrated.document, { strict: options.strict }), physics = null;if (options.engine) { const runtimeValidation = validateWithEngine(migrated.document, options);diagnostics = diagnostics.concat(runtimeValidation.diagnostics);physics = runtimeValidation.executions[0] || null; }
    const failures = diagnostics.filter(item => item.severity === 'error' || (options['warnings-as-errors'] && item.severity === 'warning'));
    if (failures.length && !options['allow-invalid']) throw new DomainError('E_PROJECT_INVALID', `Project validation failed with ${failures.length} issue${failures.length === 1 ? '' : 's'}`, { exitCode: EXIT.VALIDATION, details: { diagnostics } });
    return { command: 'validate.fix', data: mutationMode(context, migrated.document, options, { valid: !failures.length, sourceDialect: migrated.dialect, migrated: migrated.migrated, ...(physics ? { physics } : {}) }), diagnostics };
  }
  let diagnostics = validateDocument(context.document, { strict: options.strict });
  let physics = null;
  if (options.engine && !diagnostics.some(item => item.severity === 'error')) { const runtimeValidation = validateWithEngine(context.document, options);diagnostics = diagnostics.concat(runtimeValidation.diagnostics);physics = runtimeValidation.executions[0] || null; }
  const failures = diagnostics.filter(item => item.severity === 'error' || (options['warnings-as-errors'] && item.severity === 'warning'));
  if (failures.length) throw new DomainError('E_PROJECT_INVALID', `Project validation failed with ${failures.length} issue${failures.length === 1 ? '' : 's'}`, { exitCode: EXIT.VALIDATION, details: { diagnostics } });
  return { command: 'validate', data: { file: context.file, valid: true, dialect: detectDialect(context.document), sha256: context.hash, sceneCount: context.document.scenes?.length || 0, ...(physics ? { physics } : {}) }, diagnostics };
}

function inspectProject(context) {
  const document = context.document, diagnostics = validateDocument(document), scenes = Array.isArray(document.scenes) ? document.scenes : [];
  return {
    command: 'inspect', diagnostics,
    data: {
      file: context.file, sha256: context.hash, dialect: detectDialect(document), format: document.format, version: document.version,
      name: document.meta?.name || null, currentSceneId: document.currentSceneId || document.meta?.currentSceneId || null,
      runtime: document.engine?.runtime || document.engine?.renderer || null,
      physics: { ...configuredPhysics(document), gravity: document.engine?.gravity || null, pixelsPerMeter: document.engine?.pixelsPerMeter || null },
      scenes: scenes.map(scene => ({ id: scene.id, name: scene.name, objectCount: scene.objects?.length || 0 })),
      resources: { assets: document.assets?.length || 0, folders: document.folders?.length || 0, prefabs: Array.isArray(document.prefabs) ? document.prefabs.length : (document.prefab?.length || 0), animations: document.animations?.length || 0, particles: document.particles?.length || 0 }
    }
  };
}

function simulate(context, options) {
  const migrated = migrateDocument(context.document), selector = sceneSelector(options), scene = resolveScene(migrated.document, selector.sceneId || selector.scene, { allowName: Boolean(selector.sceneName) });
  const steps = integerOption(options.steps, 60, 1, 100000, 'steps'), dt = numberOption(options.dt, 1 / 60, Number.EPSILON, 0.25, 'dt');
  const AH2D = loadEngine(), gravity = migrated.document.engine?.gravity || { x: 0, y: 980 }, pixelsPerMeter = Number(migrated.document.engine?.pixelsPerMeter) || 100;
  const { engine, physics } = createPhysicsEngine(AH2D, migrated.document, { backend: options.backend, physicsOptions: { maxStep: Math.min(dt, 1 / 60) } });
  const events = [];let simulationStep = 0;
  for (const type of ['physics:collisionstart', 'physics:collisionend', 'physics:triggerenter', 'physics:triggerexit']) engine.events.on(type, event => events.push({ type, step: simulationStep, a: event.a, b: event.b, phase: event.phase }));
  engine.load(migrated.document, { sceneId: scene.id });
  for (simulationStep = 1; simulationStep <= steps; simulationStep += 1) engine.update(dt);
  const entities = [...engine.ecs.entities].map(id => ({ id, transform: clone(engine.ecs.get(id, 'Transform')), rigidbody: clone(engine.ecs.get(id, 'Rigidbody')) })).sort((a, b) => a.id.localeCompare(b.id));
  const base = { sceneId: scene.id, steps, dt, duration: steps * dt, physics, gravity: clone(gravity), pixelsPerMeter, entities, events };
  if (!options.commit) return { command: 'simulate', data: { ...base, committed: false, file: context.file, sha256: context.hash } };
  const active = resolveScene(migrated.document, scene.id);
  for (const entity of active.objects) {
    const transform = engine.ecs.get(entity.id, 'Transform'), body = engine.ecs.get(entity.id, 'Rigidbody');if (!transform) continue;
    const authoredTransform = getComponent(entity, 'Transform');
    putComponent(entity, 'Transform', { ...authoredTransform.value, x: transform.x, y: transform.y, rotation: transform.rotation, scaleX: transform.scaleX, scaleY: transform.scaleY }, { provenance: authoredTransform.provenance });
    if (body) { const authoredBody = getComponent(entity, 'Rigidbody');if (authoredBody.value !== undefined) putComponent(entity, 'Rigidbody', { ...authoredBody.value, velocityX: body.velocityX, velocityY: body.velocityY, angularVelocity: body.angularVelocity, sleeping: body.sleeping }, { provenance: authoredBody.provenance }); }
  }
  migrated.document.currentSceneId = scene.id;syncActiveMirror(migrated.document);
  assertValid(migrated.document);
  return { command: 'simulate.commit', data: mutationMode(context, migrated.document, options, { ...base, committed: true }) };
}

function numberOption(value, fallback, min, max, label) {
  if (value == null) return fallback;const number = Number(value);if (!Number.isFinite(number) || number < min || number > max) throw new DomainError('E_NUMBER_OPTION', `${label} must be between ${min} and ${max}`, { exitCode: EXIT.USAGE });return number;
}

function integerOption(value, fallback, min, max, label) {
  const number = numberOption(value, fallback, min, max, label);if (!Number.isInteger(number)) throw new DomainError('E_INTEGER_OPTION', `${label} must be an integer`, { exitCode: EXIT.USAGE });return number;
}

function capabilities() {
  return {
    protocol: PROTOCOL, cliVersion: CLI_VERSION, projectVersion: PROJECT_VERSION, defaultFormat: 'json',
    dataModel: clone(DATA_MODEL_DESCRIPTOR),
    componentSchemas: {
      version: DATA_MODEL_DESCRIPTOR.componentSchemaVersion,
      profiles: [...COMPONENT_SCHEMA_PROFILES],
      unknownComponents: 'preserve',
      precedence: 'components',
      types: componentSchemaTypes()
    },
    sceneGraph: {
      hierarchyStorage: 'parentId',
      authoringTransformSpace: 'local',
      derivedWorldMatrix: '[a,b,c,d,e,f]',
      reparentDefault: 'preserve-local',
      reparentModes: { preserveLocal: '--preserve-local', preserveWorld: '--preserve-world' },
      treeOutput: { command: 'entity list --tree', includeWorld: '--world' }
    },
    commands: {
      project: ['init', 'show', 'patch'], scene: ['list', 'get', 'create', 'clone', 'rename', 'select', 'delete', 'export', 'import'],
      entity: ['list', 'tree', 'get', 'create', 'clone', 'rename', 'set', 'patch', 'reparent', 'delete'],
      component: ['list', 'get', 'put', 'set', 'patch', 'delete'], resource: ['list', 'get', 'put', 'delete'],
      prefab: ['asset list', 'asset get', 'asset create', 'asset update', 'asset delete', 'instantiate', 'override inspect', 'override set', 'override apply', 'override revert', 'unpack'],
      runtime: ['get', 'set'], physics: ['get', 'set'], schema: ['list', 'show'],
      topLevel: ['init', 'inspect', 'validate', 'format', 'migrate', 'query', 'patch', 'apply', 'simulate', 'ecs export', 'doctor', 'version', 'capabilities']
    },
    enums: {
      runtime: ['pixijs', 'phaserjs', 'custom'], physicsBackend: [...PHYSICS_BACKENDS], rigidbodyType: ['static', 'dynamic', 'kinematic'],
      colliderShape: ['rectangle', 'box', 'circle'], animationTrackType: ['sprite', 'position', 'rotation', 'event', 'hitbox', 'bone', 'ik'],
      particleCurveProperty: ['emission', 'scale', 'speed', 'opacity', 'hue'],
      particleCurveInterpolation: ['linear', 'step', 'cubic'], particleShape: ['point', 'circle', 'box'], particleBlend: ['normal', 'additive'],
      bendDirection: [-1, 1]
    },
    options: {
      physicsBackend: {
        flag: '--backend', values: [...PHYSICS_BACKENDS],
        commands: ['physics set', 'validate --engine', 'simulate', 'ecs export'],
        default: 'engine.physics (box2d when absent)'
      }
    },
    selectors: {
      scene: { byId: ['--scene ID', '--scene-id ID'], byName: '--scene-name NAME' },
      entity: { byId: ['--entity ID', '--entity-id ID', 'positional ID'], byName: '--entity-name NAME' },
      unparent: '--root',
      reparentTransform: { default: 'preserve-local', preserveLocal: '--preserve-local', preserveWorld: '--preserve-world' }
    },
    prefabs: {
      storage: 'prefabs', legacyStorage: 'prefab', instanceComponent: 'PrefabInstance', expandedInstances: true,
      overridePath: 'RFC 6901 relative to Entity', overrideOps: ['add', 'replace', 'remove'],
      placement: { root: ['parentId', 'Transform'], inherited: false },
      connectedMutationPolicy: {
        structural: 'unpack-required',
        properties: 'prefab override set',
        rootPlacement: ['entity set', 'component put', 'component patch', 'component set', 'entity reparent']
      },
      overrideSynchronization: {
        orphanedDescendants: 'promote-to-changed-ancestor',
        arrayIndexes: 'reindex-or-promote-array',
        staleInstanceGroups: 'skip'
      },
      componentContainerSynthesis: 'direct /components/<Type> add only',
      deleteLiveInstances: '--unpack-instances', overrideSelection: '--path or --all', overrideRemoval: '--remove',
      operations: ['prefab.asset.create', 'prefab.asset.update', 'prefab.asset.delete', 'prefab.instantiate', 'prefab.override.set', 'prefab.override.apply', 'prefab.override.revert', 'prefab.unpack']
    },
    animations: {
      storage: 'animations', schema: 'animationClip', component: 'Animation', stableReference: 'clipId',
      legacyReference: 'clip', trackTypes: ['sprite', 'position', 'rotation', 'event', 'hitbox', 'bone', 'ik'],
      timebase: { authoring: 'frame', duration: 'frameCount / fps' },
      mutation: 'resource put|delete or project patch/apply'
    },
    particles: {
      storage: 'particles', schema: 'particleAsset', component: 'ParticleEmitter', stableReference: 'assetId',
      version: 1, normalizedTime: [0, 1], curveProperties: ['emission', 'scale', 'speed', 'opacity', 'hue'],
      curveInterpolations: ['linear', 'step', 'cubic'], legacyFlat: 'preserve-and-warn',
      runtimeOnly: ['ParticleEmitter.particles', 'ParticleEmitter.emissionAccumulator', 'ParticleEmitter.completed', 'ParticleEmitter.rngState'],
      mutation: 'resource put|delete or project patch/apply'
    },
    skeletons: {
      components: ['Skeleton', 'Bone', 'IK', 'Skin'],
      referenceScope: 'same Scene or Prefab Asset',
      hierarchy: { root: 'Skeleton.rootBoneId', parent: 'Entity.parentId', ikChainOrder: 'ancestor-to-descendant' },
      skinning: {
        vertices: 'Skin.vertices', weights: 'vertices[].weights[]', positiveWeightTotal: true,
        topology: { uvsPerVertex: 2, indexPrimitive: 'triangles', indicesMustReferenceVertices: true, emptyMesh: true }
      },
      runtimeOnly: ['Skeleton.pose', 'Skeleton.boneMatrices', 'Skin.deformedVertices'],
      animationTrackTypes: ['bone', 'ik']
    },
    mutationSafety: { explicitWrite: ['--write', '--out', '--print-document', '--dry-run'], optimisticConcurrency: '--expect-sha256', atomicReplace: true, batchRollback: true, unknownFieldsPreserved: true },
    input: { project: ['--file PATH', '--file -'], jsonValue: ['JSON', '@file.json', '-'] },
    output: { protocol: PROTOCOL, default: 'json', human: '--format text', pretty: '--pretty' }
  };
}

function componentSchemaTypes() {
  return componentRegistry.list().map(component => component.type);
}

const schemas = {
  project: { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'AH2D Project', type: 'object', required: ['format', 'version', 'currentSceneId', 'scenes'], properties: { format: { const: 'AH2D' }, version: { type: 'integer', maximum: PROJECT_VERSION }, dataModel: { type: 'object', required: ['id', 'version', 'componentSchemaVersion'], properties: { id: { const: DATA_MODEL_DESCRIPTOR.id }, version: { const: DATA_MODEL_DESCRIPTOR.version }, componentSchemaVersion: { const: DATA_MODEL_DESCRIPTOR.componentSchemaVersion } }, additionalProperties: true }, currentSceneId: { type: 'string' }, scenes: { type: 'array', minItems: 1, items: { $ref: '#/$defs/scene' } }, prefabs: { type: 'array', items: { $ref: '#/$defs/prefabAsset' } }, animations: { type: 'array', items: { $ref: '#/$defs/animationClip' } }, particles: { type: 'array', items: { $ref: '#/$defs/particleAsset' } } }, $defs: { scene: { type: 'object', required: ['id', 'name', 'objects'], properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' }, objects: { type: 'array', items: { $ref: '#/$defs/entity' } } }, additionalProperties: true }, entity: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 }, parentId: { type: ['string', 'null'], minLength: 1, description: 'Stable ID of the parent Entity in the same Scene; Transform is local to this parent.' }, x: { type: 'number', description: 'Local X position.' }, y: { type: 'number', description: 'Local Y position.' }, rot: { type: 'number', description: 'Local rotation in degrees.' }, rotation: { type: 'number', description: 'Local rotation in degrees.' }, sx: { type: 'number', description: 'Local X scale.' }, sy: { type: 'number', description: 'Local Y scale.' }, scaleX: { type: 'number', description: 'Local X scale.' }, scaleY: { type: 'number', description: 'Local Y scale.' }, components: { type: 'object' } }, additionalProperties: true }, prefabAsset: clone(PREFAB_ASSET_SCHEMA), animationClip: clone(ANIMATION_CLIP_SCHEMA), particleAsset: clone(PARTICLE_ASSET_SCHEMA) } },
  prefabAsset: clone(PREFAB_ASSET_SCHEMA),
  animationClip: clone(ANIMATION_CLIP_SCHEMA),
  particleAsset: clone(PARTICLE_ASSET_SCHEMA),
  operation: { type: 'object', required: ['op'], properties: { op: { type: 'string', pattern: '^(scene|entity|component|resource|runtime|physics|project|prefab)\\.' } }, additionalProperties: true },
  batch: { type: 'array', minItems: 1, items: { $ref: '#/$defs/operation' }, $defs: { operation: { type: 'object', required: ['op'], properties: { op: { type: 'string' } } } } }
};

function schemaCommand(positionals, options) {
  const action = (positionals.shift() || 'list').toLowerCase();
  if (action === 'list') return { command: 'schema.list', data: { schemas: Object.keys(schemas), components: componentSchemaTypes() } };
  const name = options.name || positionals.shift();
  const prefixed = typeof name === 'string' && /^component:/i.test(name) ? name.slice(name.indexOf(':') + 1) : null;
  const componentReference = options.component || prefixed;
  if (componentReference) {
    const component = componentRegistry.describe(componentReference);
    if (!component?.registered) throw new DomainError('E_SCHEMA_NOT_FOUND', `Component schema not found: ${componentReference}`, { exitCode: EXIT.NOT_FOUND });
    return { command: 'schema.show', data: { name: `component:${component.type}`, component } };
  }
  if (!schemas[name]) throw new DomainError('E_SCHEMA_NOT_FOUND', `Schema not found: ${name}`, { exitCode: EXIT.NOT_FOUND });
  return { command: 'schema.show', data: { name, schema: schemas[name] } };
}

const HELP = `AH2D Engine CLI ${CLI_VERSION}

Usage:
  ah2d <command> [subcommand] --file <project.json> [options]

Agent discovery:
  ah2d capabilities
  ah2d schema list|show --name project|--component Transform

Core:
  ah2d init --file game.ah2d.json --name Game
  ah2d inspect|validate|format|migrate --file game.ah2d.json
  ah2d validate --engine [--backend box2d|builtin]
  ah2d query --file game.ah2d.json --pointer /scenes/0/objects
  ah2d patch --file game.ah2d.json --patch @change.json --write
  ah2d apply --file game.ah2d.json --ops @operations.json --write

Domain commands:
  ah2d scene list|create|clone|rename|select|delete
  ah2d entity list|tree|get|create|clone|rename|set|patch|reparent|delete
  ah2d component list|get|put|set|patch|delete
  ah2d prefab asset list|get|create|update|delete
  ah2d prefab instantiate|unpack
  ah2d prefab override inspect|set|apply|revert
  ah2d resource list|get|put|delete
  ah2d runtime get|set
  ah2d physics get|set [--backend box2d|builtin]
  ah2d simulate [--backend box2d|builtin] [--steps 60 --dt 0.0166667] [--commit --write]
  ah2d ecs export [--backend box2d|builtin] --out active.ecs.json

Mutations are safe by default and require --write, --out, --print-document, or --dry-run.
Selectors use IDs. Use --scene-name or --entity-name for explicit name lookup.
Use entity reparent <entity> --root to remove its parent.
Reparent preserves local Transform by default; choose --preserve-world to keep the world matrix.
Delete --reparent accepts the same preserve mode; transform flags otherwise require reparenting.
Use entity list --tree --world for nested paths and derived local/world matrices.
Default output is ${PROTOCOL} JSON; use --format text for human-readable output.`;

function dispatch(parsed) {
  const positionals = [...parsed.positionals], options = parsed.options;
  let command = (positionals.shift() || (options.version ? 'version' : options.help ? 'help' : '')).toLowerCase();
  if (!command || command === 'help' || options.help) return { command: 'help', data: { help: HELP } };
  if (command === 'version') return { command: 'version', data: { cli: CLI_VERSION, protocol: PROTOCOL, project: PROJECT_VERSION, node: process.version } };
  if (command === 'capabilities') return { command, data: capabilities() };
  if (command === 'schema') return schemaCommand(positionals, options);
  if (command === 'doctor') { let engine = null, error = null;try { engine = loadEngine().VERSION; } catch (caught) { error = caught.message; }return { command, data: { ok: !error, cliVersion: CLI_VERSION, node: process.version, platform: process.platform, cwd: process.cwd(), engineVersion: engine, enginePath: path.join(__dirname, '..', 'AH2DEngine.js'), error } }; }
  if (command === 'init') return initProject({ positionals, options });
  if (command === 'project') {
    const action = (positionals.shift() || 'show').toLowerCase();if (action === 'init') return initProject({ positionals, options });
    const context = readProject(options.file || positionals.shift());
    if (action === 'show') return { command: 'project.show', data: { file: context.file, sha256: context.hash, document: context.document } };
    if (action === 'patch') {
      const source = requiredValue(options.patch ?? positionals.shift(), 'project patch requires a JSON merge patch');
      const patch = readValue(source, options);
      return operationResult(context, [{ op: 'project.patch', patch }], options, 'project.patch');
    }
    throw new DomainError('E_COMMAND', `Unknown project command: ${action}`, { exitCode: EXIT.USAGE });
  }
  const directFile = options.file || ((['inspect', 'validate', 'format', 'migrate'].includes(command) && positionals.length) ? positionals.shift() : undefined);
  const context = readProject(directFile);
  if (command === 'inspect') return inspectProject(context);
  if (command === 'validate') return validateCommand(context, options);
  if (command === 'format') {
    const content = jsonText(context.document), formatted = context.raw.replace(/\r\n/g, '\n') === content;
    if (options.check) { if (!formatted) throw new DomainError('E_FORMAT_CHECK', 'Project is not canonically formatted', { exitCode: EXIT.VALIDATION, details: { file: context.file } });return { command: 'format.check', data: { file: context.file, formatted: true, sha256: context.hash } }; }
    return { command: 'format', data: mutationMode(context, context.document, options, { formatted: true }) };
  }
  if (command === 'migrate') { const migrated = migrateDocument(context.document, { allowFuture: options['allow-future'] });const diagnostics = assertValid(migrated.document, { warningsAsErrors: options['warnings-as-errors'] });return { command, data: mutationMode(context, migrated.document, options, { sourceDialect: migrated.dialect, migrated: migrated.migrated }), diagnostics }; }
  if (command === 'query') { const pointer = options.pointer ?? positionals.shift() ?? '';return { command, data: { file: context.file, pointer, value: clone(getPointer(context.document, pointer)), sha256: context.hash } }; }
  if (command === 'patch') {
    const patch = readValue(options.patch ?? positionals.shift(), options), patched = applyJsonPatch(context.document, patch), migrated = migrateDocument(patched, { allowFuture: options['allow-future'] });syncActiveMirror(migrated.document);const diagnostics = options['allow-invalid'] ? validateDocument(migrated.document) : assertValid(migrated.document, { warningsAsErrors: options['warnings-as-errors'] });return { command, data: mutationMode(context, migrated.document, options, { operations: patch.length }), diagnostics };
  }
  if (command === 'apply') { const operations = readValue(options.ops ?? options.operations ?? positionals.shift(), options);return operationResult(context, operations, options, command); }
  if (command === 'scene') return sceneCommand(context, positionals, options);
  if (command === 'entity') return entityCommand(context, positionals, options);
  if (command === 'component') return componentCommand(context, positionals, options);
  if (command === 'prefab') return prefabCommand(context, positionals, options);
  if (command === 'resource') return resourceCommand(context, positionals, options);
  if (command === 'runtime') return runtimeCommand(context, positionals, options);
  if (command === 'physics') return physicsCommand(context, positionals, options);
  if (command === 'simulate') return simulate(context, options);
  if (command === 'ecs') return ecsCommand(context, positionals, options);
  throw new DomainError('E_COMMAND', `Unknown command: ${command}`, { exitCode: EXIT.USAGE });
}

function sceneCommand(context, positionals, options) {
  const action = (positionals.shift() || 'list').toLowerCase(), migrated = migrateDocument(context.document), document = migrated.document;
  if (action === 'list') return { command: 'scene.list', data: { file: context.file, currentSceneId: document.currentSceneId, scenes: document.scenes.map(scene => ({ id: scene.id, name: scene.name, objectCount: Array.isArray(scene.objects) ? scene.objects.length : 0, active: scene.id === document.currentSceneId, updatedAt: scene.updatedAt || null })) } };
  if (action === 'import') { const input = options.input || positionals.shift();if (!input) throw new DomainError('E_INPUT', 'scene import requires --input', { exitCode: EXIT.USAGE });const source = String(input), imported = readValue(source === '-' || source.startsWith('@') ? source : `@${source}`, options);const objects = imported.objects || imported.scene;if (!Array.isArray(objects)) throw new DomainError('E_SCENE_IMPORT', 'Imported Scene needs an objects array', { exitCode: EXIT.VALIDATION });return operationResult(context, [{ op: 'scene.create', id: options.id || imported.id, name: options.name || imported.name, objects, activate: options.activate }], options, 'scene.import'); }
  if (action === 'create') return operationResult(context, [{ op: 'scene.create', id: options.id, name: options.name || positionals.shift(), objects: options.objects ? readValue(options.objects, options) : [], activate: options.activate }], options, 'scene.create');
  const selector = sceneSelector(options), hasOptionSelector = options.scene != null || options['scene-id'] != null || options['scene-name'] != null;if (!hasOptionSelector) selector.sceneId = positionals.shift();
  if (action === 'get') { const scene = resolveScene(document, selector.sceneId || selector.scene, { allowName: Boolean(selector.sceneName) });return { command: 'scene.get', data: { file: context.file, scene: clone(scene), active: scene.id === document.currentSceneId } }; }
  if (action === 'export') { const scene = resolveScene(document, selector.sceneId || selector.scene, { allowName: Boolean(selector.sceneName) }), asset = { format: 'AH2D.Scene', version: 1, id: scene.id, name: scene.name, objects: clone(scene.objects) };if (options.out) writeAtomic(resolveFile(options.out), jsonText(asset), options);return { command: 'scene.export', data: { sceneId: scene.id, file: options.out ? resolveFile(options.out) : null, document: options.out && !options['print-document'] ? undefined : asset } }; }
  let operation;
  if (action === 'clone') operation = { op: 'scene.clone', ...selector, name: options.name || positionals.shift(), id: options.id, activate: options.activate, keepIds: options['keep-ids'] };
  else if (action === 'rename') operation = { op: 'scene.rename', ...selector, name: options.name || positionals.shift() };
  else if (action === 'select' || action === 'set-current') operation = { op: 'scene.select', ...selector };
  else if (action === 'delete' || action === 'remove') operation = { op: 'scene.delete', ...selector, force: options.force };
  else throw new DomainError('E_COMMAND', `Unknown scene command: ${action}`, { exitCode: EXIT.USAGE });
  return operationResult(context, [operation], options, `scene.${action}`);
}

function entityCommand(context, positionals, options) {
  const action = (positionals.shift() || 'list').toLowerCase(), migrated = migrateDocument(context.document), document = migrated.document, selector = sceneSelector(options), scene = resolveScene(document, selector.sceneId || selector.scene, { allowName: Boolean(selector.sceneName) });
  if (action === 'list' || action === 'tree') return { command: 'entity.list', data: { file: context.file, sceneId: scene.id, entities: listEntities(scene, { tree: action === 'tree' || options.tree, world: options.world, kind: options.kind, component: options.component }) } };
  if (action === 'create') {
    const data = options.data ? readValue(options.data, options) : {};
    const operation = { op: 'entity.create', ...selector, entity: isObjectValue(data), id: options.id, name: options.name || positionals.shift(), kind: options.kind, parentId: options.parent, x: options.x, y: options.y, width: options.width, height: options.height, rotation: options.rotation, scaleX: options['scale-x'], scaleY: options['scale-y'], layer: options.layer, color: options.color };
    return operationResult(context, [operation], options, 'entity.create');
  }
  const hasOptionSelector = options.entity != null || options['entity-id'] != null || options['entity-name'] != null, entitySelect = entitySelector(options, hasOptionSelector ? null : positionals.shift());
  if (action === 'get') { const entity = resolveEntity(scene, entitySelect.entityId, { allowName: Boolean(entitySelect.entityName) });return { command: 'entity.get', data: { file: context.file, sceneId: scene.id, entity: clone(entity), components: listComponents(entity) } }; }
  let operation = { ...selector };
  if (action === 'clone' || action === 'duplicate') operation = { op: 'entity.clone', ...selector, ...entitySelect, name: options.name || positionals.shift(), deep: options.deep, offsetX: options['offset-x'], offsetY: options['offset-y'] };
  else if (action === 'rename') operation = { op: 'entity.rename', ...selector, ...entitySelect, name: options.name || positionals.shift() };
  else if (action === 'set') operation = { op: 'entity.set', ...selector, ...entitySelect, path: options.path || positionals.shift(), value: readValue(options.value ?? positionals.shift(), options) };
  else if (action === 'patch') {
    const source = requiredValue(options.patch ?? positionals.shift(), 'entity patch requires a JSON merge patch');
    operation = { op: 'entity.patch', ...selector, ...entitySelect, patch: readValue(source, options) };
  }
  else if (action === 'reparent' || action === 'parent') {
    if (options['preserve-world'] && options['preserve-local']) {
      throw new DomainError('E_REPARENT_TRANSFORM_MODE', 'Choose only one of --preserve-world or --preserve-local', { exitCode: EXIT.USAGE });
    }
    operation = { op: 'entity.reparent', ...selector, ...entitySelect, parentId: options.root ? null : (options.parent ?? options['parent-id'] ?? positionals.shift()), preserveWorld: options['preserve-world'] === true, preserveLocal: options['preserve-local'] === true };
  }
  else if (action === 'delete' || action === 'remove') {
    if (options.cascade && options.reparent) {
      throw new DomainError('E_DELETE_MODE', 'Choose only one of --cascade or --reparent when deleting an Entity', { exitCode: EXIT.USAGE });
    }
    if (options['preserve-world'] && options['preserve-local']) {
      throw new DomainError('E_REPARENT_TRANSFORM_MODE', 'Choose only one of --preserve-world or --preserve-local', { exitCode: EXIT.USAGE });
    }
    if ((options['preserve-world'] || options['preserve-local']) && !options.reparent) {
      throw new DomainError('E_DELETE_TRANSFORM_MODE', '--preserve-world and --preserve-local require --reparent when deleting an Entity', { exitCode: EXIT.USAGE });
    }
    operation = { op: 'entity.delete', ...selector, ...entitySelect, cascade: options.cascade, reparent: options.reparent, preserveWorld: options['preserve-world'] === true, preserveLocal: options['preserve-local'] === true };
  }
  else throw new DomainError('E_COMMAND', `Unknown entity command: ${action}`, { exitCode: EXIT.USAGE });
  return operationResult(context, [operation], options, `entity.${action}`);
}

function componentCommand(context, positionals, options) {
  const action = (positionals.shift() || 'list').toLowerCase(), migrated = migrateDocument(context.document), document = migrated.document, sceneSelect = sceneSelector(options), scene = resolveScene(document, sceneSelect.sceneId || sceneSelect.scene, { allowName: Boolean(sceneSelect.sceneName) });
  const hasEntitySelector = options.entity != null || options['entity-id'] != null || options['entity-name'] != null, entityReference = hasEntitySelector ? null : positionals.shift(), entitySelect = entitySelector(options, entityReference), entity = resolveEntity(scene, entitySelect.entityId, { allowName: Boolean(entitySelect.entityName) });
  if (action === 'list') return { command: 'component.list', data: { file: context.file, sceneId: scene.id, entityId: entity.id, components: listComponents(entity) } };
  const type = options.component || options.type || positionals.shift();
  if (action === 'get') { const component = getComponent(entity, type);if (component.value === undefined) throw new DomainError('E_COMPONENT_NOT_FOUND', `Component not found: ${type}`, { exitCode: EXIT.NOT_FOUND });return { command: 'component.get', data: { file: context.file, sceneId: scene.id, entityId: entity.id, component: component.type, storage: component.storage, provenance: component.provenance, conflicts: clone(component.conflicts), value: clone(component.value) } }; }
  let operation;
  if (action === 'put' || action === 'add') operation = { op: 'component.put', ...sceneSelect, ...entitySelect, component: type, value: options.value !== undefined ? readValue(options.value, options) : undefined };
  else if (action === 'patch') {
    const source = requiredValue(options.patch ?? positionals.shift(), 'component patch requires a JSON merge patch');
    operation = { op: 'component.patch', ...sceneSelect, ...entitySelect, component: type, patch: readValue(source, options) };
  }
  else if (action === 'set') operation = { op: 'component.set', ...sceneSelect, ...entitySelect, component: type, path: options.path || positionals.shift(), value: readValue(options.value ?? positionals.shift(), options) };
  else if (action === 'delete' || action === 'remove') operation = { op: 'component.delete', ...sceneSelect, ...entitySelect, component: type };
  else throw new DomainError('E_COMMAND', `Unknown component command: ${action}`, { exitCode: EXIT.USAGE });
  return operationResult(context, [operation], options, `component.${action}`);
}

function prefabCommand(context, positionals, options) {
  let section = (positionals.shift() || 'asset').toLowerCase();
  if (['list', 'get', 'create', 'update', 'delete', 'remove'].includes(section)) { positionals.unshift(section);section = 'asset'; }
  const migrated = migrateDocument(context.document), document = migrated.document;
  if (section === 'asset' || section === 'assets') {
    const action = (positionals.shift() || 'list').toLowerCase(), list = prefabAssets(document);
    if (action === 'list') {
      return {
        command: 'prefab.asset.list',
        data: {
          file: context.file, sha256: context.hash,
          prefabs: list.map(asset => typeof asset === 'object' && asset !== null
            ? { id: asset.id || null, name: asset.name || null, rootEntityId: asset.rootEntityId || null, entityCount: Array.isArray(asset.entities) ? asset.entities.length : 0 }
            : { id: null, name: String(asset), rootEntityId: null, entityCount: 0 })
        }
      };
    }
    const reference = options.prefab || options['prefab-id'] || (action === 'create' ? options.id : (options.id || positionals.shift()));
    if (action === 'get') {
      const prefab = resolvePrefab(document, requiredValue(reference, 'prefab asset get requires a Prefab ID'));
      return { command: 'prefab.asset.get', data: { file: context.file, sha256: context.hash, prefab: clone(prefab) } };
    }
    if (action === 'create') {
      const valueSource = options.value ?? options.data;
      const entityReference = options.entity || options['entity-id'] || (options['entity-name'] == null ? positionals.shift() : null);
      const operation = {
        op: 'prefab.asset.create', ...sceneSelector(options),
        prefabId: reference, name: options.name,
        ...(options['entity-name'] != null ? { entity: options['entity-name'], entityName: true } : { entityId: entityReference }),
        ...(valueSource !== undefined ? { value: readValue(valueSource, options) } : {})
      };
      if (valueSource === undefined && !entityReference && options['entity-name'] == null) throw new DomainError('E_REQUIRED_VALUE', 'prefab asset create requires --entity or --value', { exitCode: EXIT.USAGE });
      return operationResult(context, [operation], options, 'prefab.asset.create');
    }
    if (action === 'update') {
      const prefabId = requiredValue(reference, 'prefab asset update requires a Prefab ID'), patchSource = options.patch;
      const entityReference = options.entity || options['entity-id'] || (options['entity-name'] == null ? positionals.shift() : null);
      if (patchSource === undefined && !entityReference && options['entity-name'] == null) throw new DomainError('E_REQUIRED_VALUE', 'prefab asset update requires --entity or --patch', { exitCode: EXIT.USAGE });
      const operation = {
        op: 'prefab.asset.update', ...sceneSelector(options), prefabId, name: options.name,
        ...(options['entity-name'] != null ? { entity: options['entity-name'], entityName: true } : { entityId: entityReference }),
        ...(patchSource !== undefined ? { patch: readValue(patchSource, options) } : {})
      };
      return operationResult(context, [operation], options, 'prefab.asset.update');
    }
    if (action === 'delete' || action === 'remove') {
      return operationResult(context, [{ op: 'prefab.asset.delete', prefabId: requiredValue(reference, 'prefab asset delete requires a Prefab ID'), unpackInstances: options['unpack-instances'] === true }], options, 'prefab.asset.delete');
    }
    throw new DomainError('E_COMMAND', `Unknown prefab asset command: ${action}`, { exitCode: EXIT.USAGE });
  }
  if (section === 'instantiate' || section === 'instance') {
    if (section === 'instance' && (positionals[0] || '').toLowerCase() === 'create') positionals.shift();
    const prefabId = options.prefab || options['prefab-id'] || positionals.shift();
    return operationResult(context, [{
      op: 'prefab.instantiate', ...sceneSelector(options), prefabId: requiredValue(prefabId, 'prefab instantiate requires a Prefab ID'),
      rootId: options.id || options['entity-id'], parentId: options.parent || options['parent-id'], x: options.x, y: options.y
    }], options, 'prefab.instantiate');
  }
  if (section === 'override' || section === 'overrides') {
    const action = (positionals.shift() || 'inspect').toLowerCase(), sceneSelect = sceneSelector(options), scene = resolveScene(document, sceneSelect.sceneId || sceneSelect.scene, { allowName: Boolean(sceneSelect.sceneName) });
    const entityReference = options.entity || options['entity-id'] || (options['entity-name'] == null ? positionals.shift() : null);
    const entitySelect = options['entity-name'] != null ? { entityId: options['entity-name'], entityName: true } : { entityId: requiredValue(entityReference, `prefab override ${action} requires an Entity ID`) };
    const entity = resolveEntity(scene, entitySelect.entityId, { allowName: Boolean(entitySelect.entityName) });
    if (action === 'inspect' || action === 'list') return { command: 'prefab.override.inspect', data: { file: context.file, sha256: context.hash, ...inspectPrefabOverrides(document, scene, entity, { all: options.all }) } };
    if (action === 'set') {
      const path = requiredValue(options.path || positionals.shift(), 'prefab override set requires --path');
      if (options.remove !== true && options.value === undefined) throw new DomainError('E_PREFAB_OVERRIDE_VALUE', 'prefab override set requires --value or --remove', { exitCode: EXIT.USAGE });
      return operationResult(context, [{ op: 'prefab.override.set', ...sceneSelect, ...entitySelect, path, remove: options.remove === true, value: options.remove === true ? undefined : readValue(options.value, options) }], options, 'prefab.override.set');
    }
    if (action === 'apply' || action === 'revert') {
      return operationResult(context, [{ op: `prefab.override.${action}`, ...sceneSelect, ...entitySelect, path: options.path || positionals.shift(), all: options.all === true }], options, `prefab.override.${action}`);
    }
    throw new DomainError('E_COMMAND', `Unknown prefab override command: ${action}`, { exitCode: EXIT.USAGE });
  }
  if (section === 'unpack') {
    const entityReference = options.entity || options['entity-id'] || (options['entity-name'] == null ? positionals.shift() : null), selector = options['entity-name'] != null ? { entityId: options['entity-name'], entityName: true } : { entityId: requiredValue(entityReference, 'prefab unpack requires an Entity ID') };
    return operationResult(context, [{ op: 'prefab.unpack', ...sceneSelector(options), ...selector }], options, 'prefab.unpack');
  }
  throw new DomainError('E_COMMAND', `Unknown prefab command: ${section}`, { exitCode: EXIT.USAGE });
}

function resourceCommand(context, positionals, options) {
  const action = (positionals.shift() || 'list').toLowerCase(), type = options.resource || options.type || positionals.shift(), migrated = migrateDocument(context.document), field = resourceField(type, migrated.document), list = migrated.document[field];
  if (action === 'list') return { command: 'resource.list', data: { file: context.file, resource: field, items: clone(list) } };
  if (action === 'put' || action === 'add') return operationResult(context, [{ op: 'resource.put', resource: type, value: readValue(options.value ?? positionals.shift(), options) }], options, 'resource.put');
  const reference = options.id || options.name || positionals.shift();
  if (action === 'get') { const item = list.find(value => String(typeof value === 'object' ? (value.id || value.name) : value) === String(reference));if (item === undefined) throw new DomainError('E_RESOURCE_NOT_FOUND', `Resource not found: ${reference}`, { exitCode: EXIT.NOT_FOUND });return { command: 'resource.get', data: { file: context.file, resource: field, value: clone(item) } }; }
  if (action === 'delete' || action === 'remove') return operationResult(context, [{ op: 'resource.delete', resource: type, resourceId: reference }], options, 'resource.delete');
  throw new DomainError('E_COMMAND', `Unknown resource command: ${action}`, { exitCode: EXIT.USAGE });
}

function runtimeCommand(context, positionals, options) {
  const action = (positionals.shift() || 'get').toLowerCase();if (action === 'get') return { command: 'runtime.get', data: { file: context.file, runtime: context.document.engine?.runtime || context.document.engine?.renderer || null } };if (action === 'set') return operationResult(context, [{ op: 'runtime.set', runtime: options.runtime || positionals.shift() }], options, 'runtime.set');throw new DomainError('E_COMMAND', `Unknown runtime command: ${action}`, { exitCode: EXIT.USAGE });
}

function physicsCommand(context, positionals, options) {
  const action = (positionals.shift() || 'get').toLowerCase();
  if (action === 'get') {
    const configured = configuredPhysics(context.document);
    return { command: 'physics.get', data: { file: context.file, physics: configured.requested, ...configured, gravity: clone(context.document.engine?.gravity || null), pixelsPerMeter: context.document.engine?.pixelsPerMeter || null } };
  }
  if (action === 'set') {
    const gravityX = options['gravity-x'], gravityY = options['gravity-y'], pixelsPerMeter = options['pixels-per-meter'], backend = options.backend;
    if (gravityX === undefined && gravityY === undefined && pixelsPerMeter === undefined && backend === undefined) {
      throw new DomainError('E_REQUIRED_VALUE', 'physics set requires --backend, --gravity-x, --gravity-y, or --pixels-per-meter', { exitCode: EXIT.USAGE });
    }
    return operationResult(context, [{ op: 'physics.set', backend, gravityX, gravityY, pixelsPerMeter }], options, 'physics.set');
  }
  throw new DomainError('E_COMMAND', `Unknown physics command: ${action}`, { exitCode: EXIT.USAGE });
}

function ecsCommand(context, positionals, options) {
  const action = (positionals.shift() || 'export').toLowerCase();if (action !== 'export') throw new DomainError('E_COMMAND', `Unknown ecs command: ${action}`, { exitCode: EXIT.USAGE });
  const migrated = migrateDocument(context.document), selector = sceneSelector(options), scene = resolveScene(migrated.document, selector.sceneId || selector.scene, { allowName: Boolean(selector.sceneName) }), AH2D = loadEngine(), runtime = createPhysicsEngine(AH2D, migrated.document, { backend: options.backend }), engine = runtime.engine;engine.load(migrated.document, { sceneId: scene.id });engine.update(0);const document = engine.export();document.sceneId = scene.id;document.sceneName = scene.name;if (options.out) writeAtomic(resolveFile(options.out), jsonText(document), options);return { command: 'ecs.export', data: { sceneId: scene.id, physics: runtime.physics, file: options.out ? resolveFile(options.out) : null, document: options.out && !options['print-document'] ? undefined : document } };
}

function isObjectValue(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new DomainError('E_OBJECT_VALUE', 'Expected a JSON object', { exitCode: EXIT.USAGE });
  return value;
}

function renderSuccess(result, options, io) {
  if (options.quiet) return EXIT.OK;
  const envelope = { protocol: PROTOCOL, ok: true, command: result.command, changed: Boolean(result.data?.changed), data: result.data ?? {}, diagnostics: result.diagnostics || [], meta: { file: result.data?.file || null, sha256Before: result.data?.sha256Before || null, sha256After: result.data?.sha256After || result.data?.sha256 || null } };
  if (options.format === 'text') {
    if (result.command === 'help') io.stdout.write(`${result.data.help}\n`);
    else if (result.command === 'scene.list') for (const scene of result.data.scenes) io.stdout.write(`${scene.active ? '*' : ' '} ${scene.id}\t${scene.name}\t${scene.objectCount} objects\n`);
    else if (result.command === 'entity.list') for (const entity of result.data.entities) {
      const world = Array.isArray(entity.worldMatrix) ? `\tworld=[${entity.worldMatrix.join(', ')}]` : '';
      io.stdout.write(`${'  '.repeat(entity.depth || 0)}${entity.id}\t${entity.name}${world}\n`);
    }
    else io.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  } else io.stdout.write(`${JSON.stringify(envelope, null, options.pretty ? 2 : 0)}\n`);
  return EXIT.OK;
}

function renderError(error, parsed, io, command = null) {
  const options = parsed?.options || {}, domain = error instanceof DomainError ? error : new DomainError('E_INTERNAL', error.message || String(error), { exitCode: EXIT.INTERNAL, details: { stack: options['include-stack'] ? error.stack : undefined } });
  const diagnostics = domain.details?.diagnostics || [];
  const envelope = { protocol: PROTOCOL, ok: false, command: command || parsed?.positionals?.slice(0, 2).join('.') || null, error: { code: domain.code, message: domain.message, pointer: domain.pointer, details: { ...domain.details, diagnostics: undefined } }, diagnostics };
  if (options.format === 'text') io.stderr.write(`AH2D ${domain.code}: ${domain.message}${domain.pointer ? ` (${domain.pointer})` : ''}\n`);
  else io.stderr.write(`${JSON.stringify(envelope, null, options.pretty ? 2 : 0)}\n`);
  return domain.exitCode || EXIT.INTERNAL;
}

function main(argv = process.argv.slice(2), io = process) {
  let parsed;
  try { parsed = parseArgs(argv);const result = dispatch(parsed);return renderSuccess(result, parsed.options, io); }
  catch (error) { return renderError(error, parsed || { positionals: argv, options: {} }, io); }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, dispatch, capabilities, schemas, HELP, CLI_VERSION };
