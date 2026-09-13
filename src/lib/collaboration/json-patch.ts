import { CollaborationError } from "./errors";
import type { JsonPatchOperation } from "./types";

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function decodePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new CollaborationError("INVALID_JSON_POINTER", "JSON Patch paths must start with '/'.", 400, { path });
  }
  return path.slice(1).split("/").map((segment) => {
    const decoded = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (UNSAFE_SEGMENTS.has(decoded)) {
      throw new CollaborationError("UNSAFE_JSON_POINTER", "Unsafe JSON Pointer segment.", 400, { path });
    }
    return decoded;
  });
}

function arrayIndex(segment: string, length: number, allowEnd = false): number {
  if (allowEnd && segment === "-") return length;
  if (!/^(0|[1-9]\d*)$/.test(segment)) {
    throw new CollaborationError("INVALID_ARRAY_INDEX", "Invalid JSON Patch array index.", 400, { segment });
  }
  const index = Number(segment);
  if (index < 0 || index > length || (!allowEnd && index === length)) {
    throw new CollaborationError("ARRAY_INDEX_OUT_OF_RANGE", "JSON Patch array index is out of range.", 400, { index, length });
  }
  return index;
}

function locate(root: unknown, segments: string[]): { parent: Record<string, unknown> | unknown[]; key: string } {
  if (!segments.length) {
    throw new CollaborationError("ROOT_PATCH_UNSUPPORTED", "Use document replacement to replace the JSON root.");
  }
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      current = current[arrayIndex(segment, current.length)];
    } else if (current && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new CollaborationError("JSON_POINTER_NOT_FOUND", "JSON Patch path does not exist.", 400, { segment });
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new CollaborationError("JSON_POINTER_NOT_FOUND", "JSON Patch path traverses a primitive value.", 400, { segment });
    }
  }
  if (!current || typeof current !== "object") {
    throw new CollaborationError("JSON_POINTER_NOT_FOUND", "JSON Patch parent is not a container.");
  }
  return { parent: current as Record<string, unknown> | unknown[], key: segments.at(-1)! };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord);
    const bKeys = Object.keys(bRecord);
    return aKeys.length === bKeys.length &&
      aKeys.every((key) => Object.prototype.hasOwnProperty.call(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
  }
  return false;
}

export function applyJsonPatch(document: unknown, operations: JsonPatchOperation[]): unknown {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new CollaborationError("INVALID_PATCH", "A non-empty JSON Patch operations array is required.");
  }
  if (operations.length > 512) {
    throw new CollaborationError("PATCH_TOO_LARGE", "A patch may contain at most 512 operations.", 413);
  }
  const result = clone(document);
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") {
      throw new CollaborationError("INVALID_PATCH_OPERATION", "Every JSON Patch operation must be an object.");
    }
    if (typeof operation.path !== "string" || operation.path.length > 2_048) {
      throw new CollaborationError(
        "INVALID_JSON_POINTER",
        "Every JSON Patch path must be a string of at most 2048 characters.",
      );
    }
    if (!["add", "remove", "replace", "test"].includes(operation.op)) {
      throw new CollaborationError("UNSUPPORTED_PATCH_OPERATION", "Only add, remove, replace, and test are supported.", 400, { op: operation.op });
    }
    const { parent, key } = locate(result, decodePointer(operation.path));
    if (operation.op === "add") {
      if (!("value" in operation)) throw new CollaborationError("PATCH_VALUE_REQUIRED", "Add requires a value.");
      if (Array.isArray(parent)) parent.splice(arrayIndex(key, parent.length, true), 0, clone(operation.value));
      else parent[key] = clone(operation.value);
      continue;
    }
    const exists = Array.isArray(parent)
      ? key !== "-" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < parent.length
      : Object.prototype.hasOwnProperty.call(parent, key);
    if (!exists) throw new CollaborationError("JSON_POINTER_NOT_FOUND", "JSON Patch target does not exist.", 400, { path: operation.path });
    const current = Array.isArray(parent) ? parent[Number(key)] : parent[key];
    if (operation.op === "test") {
      if (!("value" in operation) || !deepEqual(current, operation.value)) {
        throw new CollaborationError("JSON_PATCH_TEST_FAILED", "JSON Patch test operation failed.", 409, { path: operation.path });
      }
    } else if (operation.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else {
      if (!("value" in operation)) throw new CollaborationError("PATCH_VALUE_REQUIRED", "Replace requires a value.");
      if (Array.isArray(parent)) parent[Number(key)] = clone(operation.value);
      else parent[key] = clone(operation.value);
    }
  }
  return result;
}
