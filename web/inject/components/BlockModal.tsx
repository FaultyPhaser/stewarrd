import { formatCredits, plural } from '../../shared/format';
import { currentRoute } from '../router';
import { getState, setDrawer, setState, useStore } from '../store';

const unitWord = (type: string) => (type === 'movie' ? 'movie' : 'season');

export function BlockModal() {
  const { block } = useStore();
  if (!block) return null;
  const close = () => setState({ block: null });
  return (
    <div id="sidecar-modal" class="sc-modal" role="dialog" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="sc-modal__box">
        <h3>You can't request this right now</h3>
        <p>{`This costs ${plural(block.unitCost, 'credit')} per ${unitWord(block.type)} and you have ${formatCredits(block.balance)}.`}</p>
        <p>Release media you're done with to earn credits, then try again.</p>
        <div class="sc-modal__actions">
          <button type="button" class="sc-btn" onClick={() => { close(); setDrawer(true); }}>Show my media</button>
          <button type="button" class="sc-btn" onClick={close}>OK</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which kind of title a Request button belongs to. A teaser card holds exactly one /movie/ or /tv/ link, so the
 * nearest ancestor with a single distinct link identifies it. Anything broader (several links) is not a card,
 * so fall back to the page being viewed. Returns null when unknown (the click is then left alone).
 */
export function typeOfButton(btn: Element): 'movie' | 'tv' | null {
  let node = btn.parentElement;
  for (let depth = 0; node && node !== document.body && depth < 8; depth += 1, node = node.parentElement) {
    const hrefs = new Set([...node.querySelectorAll('a[href^="/movie/"], a[href^="/tv/"]')]
      .map((a) => (a.getAttribute('href') ?? '').split(/[?#]/)[0]));
    if (hrefs.size === 1) return /^\/(movie|tv)\//.exec([...hrefs][0])![1] as 'movie' | 'tv';
    if (hrefs.size > 1) break;
  }
  return currentRoute(window.location.pathname)?.type ?? null;
}

/**
 * Seerr's Request buttons (detail page, teaser cards and the submit button in the request dialog) stay clickable,
 * but when the user can't pay we show our own message instead. The check uses the cached balance, so it is
 * synchronous; if anything is unknown the click goes through and the webhook still declines on the server.
 */
export function installRequestGuard(): void {
  document.addEventListener('click', (e) => {
    const { me } = getState();
    if (!me || me.credits === null) return;
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn || btn.closest('#sidecar-modal') || btn.closest('#sidecar-media-panel')) return;
    if (!/^\s*request\b/i.test(btn.textContent || '')) return; // matches "Request", not "Requested"
    const type = typeOfButton(btn);
    const unitCost = type ? me.costs?.[type] : undefined;
    if (!type || unitCost === undefined || me.credits >= unitCost) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setState({ block: { type, unitCost, balance: me.credits } });
  }, true);
}
