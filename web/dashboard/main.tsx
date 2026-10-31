import { render } from 'preact';
import { App } from './App';
import type { Flags } from './types';
import './styles.css';

// The server renders only an empty shell; what it knows (API base, feature flags) arrives as data attributes.
const { dataset } = document.body;
const flags: Flags = {
  apiBase: dataset.api ?? '/api',
  assetBase: dataset.assetBase ?? '/public',
  devMode: dataset.devMode === 'true',
  adminRun: dataset.adminRun === 'true',
  fakeLogin: dataset.fakeLogin === 'true',
};

render(<App flags={flags} />, document.getElementById('app')!);
