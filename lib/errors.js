'use strict';

/**
 * Custom error class for application-level errors.
 * Allows attaching an HTTP status code and a machine-readable error code.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { AppError };
