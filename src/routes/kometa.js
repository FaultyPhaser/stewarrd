import { Router } from 'express';
import { listFlagged } from '../services/credits.js';

const router = Router();

// Unauthenticated on purpose (Kometa can't log in). Only exposes numeric ids.
// Keep the service bound to localhost / the internal Docker network.
// Kometa works at series level, so a show is listed once if ANY of its seasons is released.
// Every request reads the database, so the lists always reflect the current "Leaving soon" state.
const ids = (type, field) => [
  ...new Set(listFlagged().filter((i) => i.media_type === type && i[field]).map((i) => i[field])),
].sort((a, b) => a - b);

const asText = (res, list) => {
  res.set('Cache-Control', 'no-store');
  res.type('text/plain').send(list.length ? `${list.join('\n')}\n` : '');
};

// Plain text for Kometa's `text_file` builder: one TMDb id per line (movie libraries).
router.get('/leaving-soon-movies.txt', (_req, res) => asText(res, ids('movie', 'tmdb_id')));

// One TVDb id per line (show libraries).
router.get('/leaving-soon-shows.txt', (_req, res) => asText(res, ids('tv', 'tvdb_id')));

// Combined JSON view (not read by Kometa; handy for checking).
router.get('/leaving-soon.json', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ movies: ids('movie', 'tmdb_id'), shows: ids('tv', 'tvdb_id') });
});

export default router;
