export type OuijaErrorCode =
  | 'UNAUTHORIZED'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'RATE_LIMIT_EXCEEDED'
  | 'VALIDATION_ERROR'
  | 'PROJECT_NOT_FOUND'
  | 'PIPELINE_NOT_FOUND'
  | 'PIPELINE_NOT_RETRYABLE'
  | 'PIPELINE_ALREADY_RUNNING'
  | 'DISPATCH_REJECTED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_EXISTS'
  | 'AGENT_UNREACHABLE'
  | 'CONFIG_ERROR'
  | 'NOT_AVAILABLE'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_CONFIG_INVALID'
  | 'GUARD_FAILED'
  | 'INTERNAL_ERROR';

export interface ValidationErrorDetail {
  field: string;
  message: string;
}

export interface OuijaError {
  code: OuijaErrorCode;
  message: string;
  details: ValidationErrorDetail[];
  requestId: string;
  retryable: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly code: OuijaErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly retryable = false,
    public readonly details: ValidationErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
