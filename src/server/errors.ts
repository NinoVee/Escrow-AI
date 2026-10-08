export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "STEP_UP_REQUIRED"
  | "RATE_LIMITED"
  | "DISABLED";

export class AppError extends Error {
  constructor(
    public code: AppErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const forbidden = (msg = "You do not have permission to perform this action.") =>
  new AppError("FORBIDDEN", msg);
/** Cross-tenant and unauthorized lookups both surface as NOT_FOUND so existence is not leaked. */
export const notFound = (what = "Record") => new AppError("NOT_FOUND", `${what} not found.`);
export const conflict = (msg: string, details?: unknown) => new AppError("CONFLICT", msg, details);
export const invalid = (msg: string, details?: unknown) => new AppError("VALIDATION", msg, details);
export const precondition = (msg: string, details?: unknown) =>
  new AppError("PRECONDITION_FAILED", msg, details);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Safe message for display; never leaks internal error text. */
export function publicMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  return "Something went wrong. The error has been logged.";
}
