import type { BulkResult } from './types';

/** One message for a bulk action: what worked, what was skipped and why. */
export function summarize(results: BulkResult[], verb: string, title: string): { text: string; isError: boolean } {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  let text = `${verb} ${ok.length} of ${results.length} season(s) of "${title}".`;
  if (failed.length) text += ` Skipped: ${failed.map((r) => `${r.label} (${r.error})`).join('; ')}.`;
  const seerrIssue = ok.some((r) => r.seerr?.action === 'error');
  if (seerrIssue) text += ' Some Seerr request updates failed; credits were still applied.';
  return { text, isError: failed.length > 0 || seerrIssue };
}
