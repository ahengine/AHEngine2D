export class CollaborationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly revision?: number;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: unknown,
    revision?: number,
  ) {
    super(message);
    this.name = "CollaborationError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.revision = revision;
  }
}

export function assertCollaboration(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): asserts condition {
  if (!condition) throw new CollaborationError(code, message, status, details);
}
