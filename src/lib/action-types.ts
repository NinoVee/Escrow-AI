export type ActionState<T = unknown> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string; code?: string; details?: unknown };

export const INITIAL_STATE: ActionState = { ok: true };

export type FormAction<T = unknown> = (prev: ActionState<T>, fd: FormData) => Promise<ActionState<T>>;
