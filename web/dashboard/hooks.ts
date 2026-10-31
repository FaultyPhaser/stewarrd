import { useEffect, useState } from 'preact/hooks';
import { errorMessage } from '../shared/format';
import { useApp } from './context';

/** Loads `path` now and again whenever the app refreshes. `null` until the first response. */
export function useLoad<T>(path: string): T | null {
  const { api, say, version } = useApp();
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    api.get<T>(path).then((d) => { if (live) setData(d); }).catch((err) => { if (live) say(errorMessage(err), true); });
    return () => { live = false; };
  }, [api, path, version]);
  return data;
}
