/** Creates a plain Error with an attached HTTP status, used by index.js's error handler. */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
