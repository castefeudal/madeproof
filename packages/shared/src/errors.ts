export class MadeProofError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MadeProofError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assertCondition(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) throw new MadeProofError(code, message, status, details);
}

export function asMadeProofError(error: unknown): MadeProofError {
  if (error instanceof MadeProofError) return error;
  if (error instanceof Error) return new MadeProofError('INTERNAL_ERROR', error.message, 500);
  return new MadeProofError('INTERNAL_ERROR', 'Unknown error', 500);
}
