import { HttpError } from '../errors.js';
import { requestJson } from './http.js';

export function createArrClient(name, { url, apiKey }) {
  return {
    configured: Boolean(url && apiKey),
    call(path, opts = {}) {
      if (!url || !apiKey) throw new HttpError(503, `${name} is not configured`);
      return requestJson(`${url}${path}`, { service: name, ...opts, headers: { 'X-Api-Key': apiKey } });
    },
  };
}
