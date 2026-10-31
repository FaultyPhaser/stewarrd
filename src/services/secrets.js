import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const cache = new Map();

/** A random value created once and kept in the data directory (mode 0600), so it survives restarts. */
export function persisted(name, make) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(config.dataDir, name);
  let value = '';
  try {
    value = fs.readFileSync(file, 'utf8').trim();
  } catch {
    // not created yet
  }
  if (!value) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    value = make();
    fs.writeFileSync(file, value, { mode: 0o600 });
  }
  cache.set(name, value);
  return value;
}
