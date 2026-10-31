export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown>) {
    super(message);
  }
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

/** JSON client for the sidecar API. The Seerr (or dashboard) session cookie travels with every call. */
export function createApi(base: string): Api {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
    return data as T;
  }
  return {
    get: (path) => request(path),
    post: (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) }),
  };
}
