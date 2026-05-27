export function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function sendControllerError(res, error, fallbackMessage = 'Request failed') {
  const status = Number(error.status || error.statusCode || 500);
  if (status >= 500) console.error(error);
  return res.status(status).json({ error: error.message || fallbackMessage });
}
