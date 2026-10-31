// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Me } from '../../shared/types';
import { getState, setState } from '../store';
import { installRequestGuard, typeOfButton } from './BlockModal';

const meWith = (credits: number | null): Me => ({ credits, costs: { movie: 2, tv: 3 } }) as unknown as Me;

/** Puts a button on the page and clicks it; returns whether the click was cancelled. */
function click(html: string, selector = 'button'): boolean {
  document.body.innerHTML = html;
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  document.querySelector(selector)!.dispatchEvent(event);
  return event.defaultPrevented;
}

const CARD = (href: string, label = 'Request') => `<div><a href="${href}">Title</a><button>${label}</button></div>`;

beforeAll(() => installRequestGuard());
beforeEach(() => {
  window.history.pushState({}, '', '/');
  setState({ me: meWith(1), block: null });
});
afterEach(() => { document.body.innerHTML = ''; });

describe('request guard', () => {
  it('blocks a Request click the user cannot afford and records what to tell them', () => {
    expect(click(CARD('/movie/1'))).toBe(true);
    expect(getState().block).toEqual({ type: 'movie', unitCost: 2, balance: 1 });
  });

  it('uses the season price for shows', () => {
    setState({ me: meWith(2) });
    expect(click(CARD('/tv/9'))).toBe(true);
    expect(getState().block).toMatchObject({ type: 'tv', unitCost: 3 });
  });

  it('lets the click through when the user can afford it', () => {
    setState({ me: meWith(2) });
    expect(click(CARD('/movie/1'))).toBe(false);
    expect(getState().block).toBeNull();
  });

  it('lets the click through with unlimited credits, no balance loaded, or an unknown type', () => {
    setState({ me: meWith(null) });
    expect(click(CARD('/movie/1'))).toBe(false);
    setState({ me: null });
    expect(click(CARD('/movie/1'))).toBe(false);
    setState({ me: meWith(0) });
    expect(click('<button>Request</button>')).toBe(false); // no link, and not on a title page
    expect(getState().block).toBeNull();
  });

  it('ignores buttons that are not Request buttons, including "Requested"', () => {
    expect(click(CARD('/movie/1', 'Requested'))).toBe(false);
    expect(click(CARD('/movie/1', 'Play'))).toBe(false);
  });

  it('ignores buttons inside its own panel and modal', () => {
    expect(click('<div id="sidecar-media-panel"><button>Request more</button></div>')).toBe(false);
    expect(click('<div id="sidecar-modal"><button>Request</button></div>')).toBe(false);
  });

  it('falls back to the page being viewed for a button outside any card', () => {
    window.history.pushState({}, '', '/tv/5');
    expect(click('<button>Request</button>')).toBe(true);
    expect(getState().block).toMatchObject({ type: 'tv' });
  });
});

describe('typeOfButton', () => {
  it('reads the type from the single link in the nearest card', () => {
    document.body.innerHTML = CARD('/tv/9?x=1#y');
    expect(typeOfButton(document.querySelector('button')!)).toBe('tv');
  });

  it('stops at an ancestor holding several different links and uses the page route instead', () => {
    window.history.pushState({}, '', '/movie/3');
    document.body.innerHTML = '<ul><li><a href="/tv/1">a</a><button>Request</button></li><li><a href="/tv/2">b</a></li></ul>';
    // The <li> has one link (tv/1), so that card wins; widen the button's context to two links to hit the fallback.
    expect(typeOfButton(document.querySelector('button')!)).toBe('tv');
    document.body.innerHTML = '<div><a href="/tv/1">a</a><a href="/tv/2">b</a><button>Request</button></div>';
    expect(typeOfButton(document.querySelector('button')!)).toBe('movie');
  });
});
