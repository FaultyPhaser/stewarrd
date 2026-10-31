import { HttpError } from '../errors.js';

/**
 * Small JSON fetch wrapper. Never includes the request URL (which may hold
 * API keys) in thrown errors.
 */
export async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 10000, service = 'Upstream' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new HttpError(502, `${service} is unreachable`, { expose: true });
  }

  if (!res.ok) {
    let upstreamMessage;
    try {
      upstreamMessage = JSON.parse(await res.text())?.message;
    } catch {
      /* body wasn't JSON; the status alone has to do */
    }
    throw new HttpError(502, `${service} returned HTTP ${res.status}`, {
      expose: true,
      upstreamStatus: res.status,
      upstreamMessage: typeof upstreamMessage === 'string' ? upstreamMessage.slice(0, 200) : undefined,
    });
  }

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `${service} returned invalid JSON`, { expose: true });
  }
}
