export type ErrorCode =
  | 'PLAN_INVALID'
  | 'PLAN_STALE'
  | 'SCOPE_MISMATCH'
  | 'POLICY_VIOLATION'
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'DEPENDENCY_MISSING'
  | 'STATE_CONFLICT'
  | 'LOCK_HELD'
  | 'RESTORE_REQUIRED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'NETWORK_ERROR'
  | 'OPERATION_FAILED'
  | 'OPERATION_UNCERTAIN'
  | 'INTERNAL_ERROR';

export const ExitCode = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  INVALID_INPUT: 2,
  AUTH_OR_DEPENDENCY: 3,
  STATE_CONFLICT: 4,
  RATE_OR_NETWORK: 5,
  PARTIAL_OR_RECOVERY: 6
} as const;

export type ExitCode = typeof ExitCode[keyof typeof ExitCode];

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    code: ErrorCode;
    message: string;
    exitCode?: ExitCode;
    retryable?: boolean;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'DomainError';
    this.code = options.code;
    this.exitCode = options.exitCode ?? errorCodeToExitCode(options.code);
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function errorCodeToExitCode(code: ErrorCode): ExitCode {
  switch (code) {
    case 'PLAN_INVALID':
    case 'SCOPE_MISMATCH':
    case 'POLICY_VIOLATION':
      return ExitCode.INVALID_INPUT;
    case 'AUTH_FAILED':
    case 'PERMISSION_DENIED':
    case 'DEPENDENCY_MISSING':
      return ExitCode.AUTH_OR_DEPENDENCY;
    case 'STATE_CONFLICT':
    case 'LOCK_HELD':
    case 'PLAN_STALE':
      return ExitCode.STATE_CONFLICT;
    case 'RATE_LIMIT_EXCEEDED':
    case 'NETWORK_ERROR':
      return ExitCode.RATE_OR_NETWORK;
    case 'RESTORE_REQUIRED':
    case 'OPERATION_FAILED':
    case 'OPERATION_UNCERTAIN':
      return ExitCode.PARTIAL_OR_RECOVERY;
    case 'INTERNAL_ERROR':
    default:
      return ExitCode.INTERNAL_ERROR;
  }
}
