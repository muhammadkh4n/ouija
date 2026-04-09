/**
 * Global error handler for Fastify.
 *
 * Rules (spec §5.3):
 *  - ApiError → structured JSON with code, message, details, requestId, retryable
 *  - Unknown errors → 500 INTERNAL_ERROR, no stack trace exposed in production
 *  - requestId is always present (attached to request by a lifecycle hook in app.ts)
 *  - Validation errors from Fastify schema validation are normalized to VALIDATION_ERROR
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '@ouija-dev/types';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (
      err: FastifyError | ApiError | Error,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const requestId = request.requestId ?? 'unknown';
      const isProd = process.env['NODE_ENV'] === 'production';

      // ApiError: structured, expected errors
      if (err instanceof ApiError) {
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
            requestId,
            retryable: err.retryable,
          },
        });
      }

      // Fastify validation errors (FST_ERR_VALIDATION or statusCode 400)
      const fastifyErr = err as FastifyError;
      if (fastifyErr.validation || fastifyErr.statusCode === 400) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: fastifyErr.message || 'Request validation failed',
            details: (fastifyErr.validation ?? []).map((v) => ({
              field: v.instancePath ?? v.schemaPath ?? '',
              message: v.message ?? 'invalid value',
            })),
            requestId,
            retryable: false,
          },
        });
      }

      // 404 from Fastify routing
      if (fastifyErr.statusCode === 404) {
        return reply.status(404).send({
          error: {
            code: 'PIPELINE_NOT_FOUND',
            message: 'Route not found',
            details: [],
            requestId,
            retryable: false,
          },
        });
      }

      // Unknown / unexpected errors — never expose details in production
      app.log.error({ err, requestId }, 'Unhandled server error');

      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred.',
          details: [],
          requestId,
          retryable: false,
          // Include stack only in development
          ...(!isProd && { debug: (err as Error).stack }),
        },
      });
    },
  );
}
