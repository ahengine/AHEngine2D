# AH2D agent workflow

Read [`Agent.md`](./Agent.md) before implementing game code, changing the serialized project contract, or extending a runtime adapter. It contains the full layer boundaries, gameplay patterns, physics rules, validation loop, and completion checklist.

For Next.js Auth, project RBAC, document revisions, comments, history, SSE, or presence, also read [`docs/COLLABORATION.md`](./docs/COLLABORATION.md). Read [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) before changing storage, sessions, realtime transport, or deployment topology.

Use the AH2D CLI for project JSON changes instead of rewriting project files by hand. It preserves unknown fields, validates Scene Graph invariants, synchronizes the active Scene mirror, and performs atomic writes.

```text
npm run ah2d -- capabilities --pretty
npm run ah2d -- schema list --pretty
npm run ah2d -- schema show --component Transform --pretty
npm run ah2d -- inspect --file <project.json> --pretty
npm run ah2d -- validate --file <project.json> --engine --pretty
```

Before a mutation, read the SHA-256 from `inspect`. Pass it back with `--expect-sha256` and explicitly choose `--write`, `--out`, `--print-document`, or `--dry-run`.

```text
npm run ah2d -- entity create --file <project.json> --scene main --id player --name Player --dry-run --include-document --pretty
npm run ah2d -- entity create --file <project.json> --scene main --id player --name Player --write --expect-sha256 <hash>
```

For multiple related changes, prefer one atomic `apply` call with an operations JSON file. Discover operations/enums through `capabilities` and component contracts through `schema list` plus `schema show --component`; do not parse human help text. CLI stdout is `ah2d.cli/v1` JSON by default. Use `--format text` only for humans.

Use `--scene-name` and `--entity-name` only for explicit name lookup; ordinary selectors are stable IDs. Use `entity reparent ... --root` to unparent rather than overloading a possible Entity ID such as `root`.

Treat every authored Transform as local to `parentId`; `Transform.world` is derived Runtime state and must not be persisted as authoring truth. Inspect deep hierarchy with `entity tree --world`. Reparent defaults to preserve-local for compatibility; use `--preserve-world` when the Entity/subtree must not move visually, and never approximate a singular/sheared conversion.

At Runtime, mutate hierarchy through `engine.graph` or `engine.reparent`, and delete graph Entities through `engine.destroyEntity` with an explicit child policy. Do not use low-level `ecs.destroy` as a complete Entity lifecycle operation.

Do not replace a universal project with `Engine.export()`. That method intentionally exports the active ECS runtime snapshot. Use `ecs export` only when an ECS snapshot is explicitly required.

Universal Project version `4` is the authoring source of truth. New projects use `dataModel: { id: "ah2d.ecs", version: 1, componentSchemaVersion: 1 }`; this descriptor and the lossy ECS snapshot version `3` are independent version axes. Persist with the `authoring` component profile, use `runtime` inside systems, and use `snapshot` only for active ECS exports.

Component values must be JSON-safe objects or arrays with safe PascalCase names. `components.<canonical-or-alias>` has precedence over legacy flat/top-level storage. Preserve reported `storage` and `provenance`, unknown fields/components, and conflicting lower-precedence copies unless an explicit migration says otherwise. Compatibility validation warns on duplicate-location conflicts; strict validation rejects them. Register custom schemas before Engine load/create when defaults, aliases, per-profile rules, normalization, or component migrations are required.

Do not edit `.ah2d-data/collaboration/*.json` directly. A Studio-managed project must be changed through `/api/projects/:projectId/document` with the latest numeric `expectedRevision` and an idempotent `clientMutationId`. The Studio revision is not the CLI SHA-256 precondition. On `REVISION_CONFLICT`, fetch, merge, and retry as a new mutation.

Never expose the `ah2d_session` cookie, password/session hashes, or auth secret. Effective access is the intersection of the uppercase global account role and lowercase per-project membership role; a global Owner does not bypass project membership. Global EDITOR has `members:manage` but still needs project `owner/admin` and has no account `roles:manage`.

Resolve Member targets from the active auth store and enforce their account-role cap before assigning a project role. Never accept client-supplied name/Email as canonical membership identity, and never assign project `owner` through the Member API.

Keep the Editor frame Auth-gated and sandboxed without `allow-same-origin`. Preserve the restrictive CSP. For its opaque-origin `postMessage` bridge, validate the exact `event.source`, expected origin, and protocol marker; marker text by itself is not authentication.

Top-level `postProcess` is project data. Preserve effect IDs, ordering, unknown effects, and custom parameters. The Engine exposes configuration through `engine.postProcess`; renderer hosts remain responsible for mapping active effects to their own filters or shaders.

When server or Studio code changes, run:

```text
npm run check
npm run test:server
npm test
npm run build
```

## Repository workflow

Use `dev` as the default branch for subsequent work. After each completed user request, run the applicable validation, commit the scoped changes, and push the commit to `origin/dev`. Synchronize or push `stage` and `main` only when the user explicitly requests it.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
