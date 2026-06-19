import { config } from '../../helpers/config.js';
import { publicErrorPayload, statusCodeForError } from '../../helpers/errors.js';
import { logger, withRequest } from '../../helpers/logger.js';

export function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function sendControllerError(req, res, error, fallbackMessage = 'Request failed') {
  const status = statusCodeForError(error);
  if (status >= 500) {
    logger.error('Controller error', withRequest(req, { statusCode: status, error }));
  }
  return res.status(status).json(publicErrorPayload(error, req, fallbackMessage, { production: config.isProduction }));
}
