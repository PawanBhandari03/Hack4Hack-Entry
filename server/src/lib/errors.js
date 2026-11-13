/** An error that maps directly to an HTTP response. `code` is a stable machine-readable string. */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, msg, details) => new HttpError(400, code, msg, details);
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'UNAUTHORIZED', msg);
export const forbidden = (code = 'FORBIDDEN', msg = 'You are not allowed to do this') => new HttpError(403, code, msg);
export const notFound = (code = 'NOT_FOUND', msg = 'Not found') => new HttpError(404, code, msg);
export const conflict = (code, msg) => new HttpError(409, code, msg);
export const gone = (code, msg) => new HttpError(410, code, msg);

export const isDuplicateKey = (err) => err?.code === 11000 || err?.cause?.code === 11000;
