export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class AuthenticationRequiredError extends AuthError {
  constructor(message = "Authentication is required.") {
    super("AUTHENTICATION_REQUIRED", message, 401);
    this.name = "AuthenticationRequiredError";
  }
}

export class AuthorizationError extends AuthError {
  constructor(message = "You do not have permission to perform this action.") {
    super("FORBIDDEN", message, 403);
    this.name = "AuthorizationError";
  }
}

export class AuthConfigurationError extends AuthError {
  constructor(message: string) {
    super("AUTH_CONFIGURATION_ERROR", message, 500);
    this.name = "AuthConfigurationError";
  }
}
