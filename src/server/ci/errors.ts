import type { ApiErrorBody, ApiErrorCode } from "@/types/ci-api";

/** Base class: every CI service error carries the HTTP status and code the API should return. */
export class CiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly details?: string[]
  ) {
    super(message);
  }
}

/** "CI database table configuration is pending: A, B." — the exact wording shown on every affected screen. */
export function pendingMessage(labels: readonly string[]): string {
  return labels.length ? `CI database table configuration is pending: ${labels.join(", ")}.` : "CI database table configuration is pending.";
}

/**
 * A CI table this request needs has no configuration yet (see server/db/schema.ts).
 * `pendingTables` are the human-readable table names; they are also returned
 * as the error `details` so a screen can list them. Status 503, code
 * NOT_CONFIGURED. A custom `message` is used when the tables ARE configured
 * but their Databricks integration has not been built.
 */
export class NotConfiguredError extends CiError {
  constructor(
    readonly pendingTables: string[] = [],
    message?: string
  ) {
    super(message ?? pendingMessage(pendingTables), 503, "NOT_CONFIGURED", pendingTables.length ? pendingTables : undefined);
  }
}

export class UnauthenticatedError extends CiError {
  constructor() {
    super("Sign in required.", 401, "UNAUTHENTICATED");
  }
}

export class ForbiddenError extends CiError {
  constructor(message = "You don't have access to this.") {
    super(message, 403, "FORBIDDEN");
  }
}

export class NotFoundError extends CiError {
  constructor(message = "Not found.") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ValidationError extends CiError {
  constructor(details: string[], message = "Please correct the highlighted fields.") {
    super(message, 400, "VALIDATION", details);
  }
}

export class EditWindowClosedError extends CiError {
  constructor(message: string) {
    super(message, 403, "EDIT_WINDOW_CLOSED");
  }
}

/** A duplicate record or conflicting role assignment (SAMBA's 409 cases). */
export class ConflictError extends CiError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

/** A feature whose server switch is off (e.g. Databricks reads or writes not yet approved). */
export class DisabledError extends CiError {
  constructor(message: string) {
    super(message, 503, "DISABLED");
  }
}

export function errorResponse(error: unknown, context: string): Response {
  if (error instanceof CiError) {
    const body: ApiErrorBody = { error: error.message, code: error.code, details: error.details };
    return Response.json(body, { status: error.status });
  }
  // Never echo internal error text (it may include SQL or warehouse detail) to the browser.
  console.error(`[CI] ${context} failed:`, error instanceof Error ? error.message : error);
  const body: ApiErrorBody = { error: "Something went wrong. Please try again.", code: "INTERNAL" };
  return Response.json(body, { status: 500 });
}
