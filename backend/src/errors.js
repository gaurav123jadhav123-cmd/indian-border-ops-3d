// An error that is safe to show to the player: it carries the HTTP status and a plain message.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const badRequest = (message) => new HttpError(400, message);
export const unauthorized = (message = 'Please sign in first.') => new HttpError(401, message);
export const forbidden = (message) => new HttpError(403, message);
export const conflict = (message) => new HttpError(409, message);
