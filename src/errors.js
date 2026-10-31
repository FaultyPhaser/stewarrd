export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = extra.expose ?? status < 500;
    Object.assign(this, extra);
  }
}
