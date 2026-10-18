import { REQUEST_ID_HEADER } from "./correlation.ts";

export interface AppErrorOptions {
  /** Machine-readable code returned to clients. Defaults per class. */
  readonly code?: string;
  /** Safe public message. Defaults per class; `undefined` on AppError means "not exposed". */
  readonly expose?: string;
  readonly cause?: unknown;
}

/**
 * Base for errors the application raises deliberately. `message` is internal (logs only);
 * `expose` is the only text that may reach a client.
 */
export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly expose: string | undefined;

  constructor(message: string, options: AppErrorOptions & { readonly httpStatus: number }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? "internal_error";
    this.httpStatus = options.httpStatus;
    this.expose = options.expose;
  }
}

function defineHttpError(httpStatus: number, code: string, publicMessage: string) {
  return class extends AppError {
    constructor(message: string = publicMessage, options: AppErrorOptions = {}) {
      super(message, {
        httpStatus,
        code: options.code ?? code,
        expose: options.expose ?? publicMessage,
        cause: options.cause,
      });
    }
  };
}

export class ValidationError extends defineHttpError(
  400,
  "validation_failed",
  "The request is invalid.",
) {}
export class UnauthorizedError extends defineHttpError(
  401,
  "unauthorized",
  "Authentication is required.",
) {}
export class ForbiddenError extends defineHttpError(
  403,
  "forbidden",
  "You do not have access to this resource.",
) {}
export class NotFoundError extends defineHttpError(
  404,
  "not_found",
  "The requested resource was not found.",
) {}
export class ConflictError extends defineHttpError(
  409,
  "conflict",
  "The request conflicts with the current state.",
) {}
export class ServiceUnavailableError extends defineHttpError(
  503,
  "service_unavailable",
  "The service is temporarily unavailable.",
) {}

export interface ConfigurationIssue {
  /** Dotted path of the failing key, or `(root)`. Never contains values. */
  readonly path: string;
  /** Zod issue code, e.g. `invalid_type`. */
  readonly code: string;
}

/** Invalid deployment configuration. Never exposed to clients. */
export class ConfigurationError extends AppError {
  readonly issues: readonly ConfigurationIssue[];

  constructor(message: string, issues: readonly ConfigurationIssue[] = []) {
    super(message, { httpStatus: 500, code: "configuration_error" });
    this.issues = issues;
  }
}

const INTERNAL = { code: "internal_error", message: "Internal error" } as const;

/** JSON error response that only ever carries an AppError's public message. */
export function toErrorResponse(error: unknown, correlationId: string): Response {
  const exposed = error instanceof AppError && error.expose !== undefined;
  const status = error instanceof AppError ? error.httpStatus : 500;
  const body = {
    error: exposed ? { code: error.code, message: error.expose } : INTERNAL,
    requestId: correlationId,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      [REQUEST_ID_HEADER]: correlationId,
    },
  });
}
