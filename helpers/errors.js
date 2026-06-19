const CLIENT_SAFE_STATUS_CODES = new Set([400, 401, 402, 403, 404, 409, 413, 422, 429]);

function statusCodeForError(error) {
  const status = Number(error?.status || error?.statusCode || 500);
  if (!Number.isInteger(status) || status < 400 || status > 599) return 500;
  return status;
}

function isClientSafeError(error) {
  const status = statusCodeForError(error);
  return Boolean(error?.expose || error?.clientSafe || CLIENT_SAFE_STATUS_CODES.has(status));
}

function publicErrorMessage(error, fallbackMessage = 'Internal server error', { production = false } = {}) {
  const status = statusCodeForError(error);
  const message = error?.message || fallbackMessage;
  if (status < 500) return message;
  if (isClientSafeError(error)) return message;
  return production ? fallbackMessage : message;
}

function publicErrorPayload(error, req, fallbackMessage = 'Internal server error', options = {}) {
  return {
    error: publicErrorMessage(error, fallbackMessage, options),
    requestId: req?.id || req?.requestId || null,
  };
}

function createHttpError(status, message, { expose = true, code = null } = {}) {
  const error = new Error(message);
  error.status = status;
  error.expose = expose;
  if (code) error.code = code;
  return error;
}

export {
  createHttpError,
  isClientSafeError,
  publicErrorMessage,
  publicErrorPayload,
  statusCodeForError,
};
