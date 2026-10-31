// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { Anchored } from './Anchored';
import { getState, setState } from './store';

const attachToBody = (node: HTMLElement) => { document.body.appendChild(node); return true; };

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('Anchored', () => {
  it('renders children into an element it creates and attaches', async () => {
    render(<Anchored id="host" attach={attachToBody}><span>hello</span></Anchored>);
    await act(async () => {});
    expect(document.getElementById('host')?.textContent).toBe('hello');
  });

  it('re-attaches the element on the next tick when the host page removes it', async () => {
    render(<Anchored id="host" attach={attachToBody}><span>hello</span></Anchored>);
    await act(async () => {});
    document.getElementById('host')!.remove();
    expect(document.getElementById('host')).toBeNull();

    await act(async () => { setState({ tick: getState().tick + 1 }); });
    expect(document.getElementById('host')?.textContent).toBe('hello');
  });

  it('renders nothing while there is nowhere to attach, then picks the spot up once it exists', async () => {
    const attach = (node: HTMLElement) => {
      const target = document.getElementById('target');
      if (!target) return false;
      target.appendChild(node);
      return true;
    };
    render(<Anchored id="host" attach={attach}><span>hello</span></Anchored>);
    await act(async () => {});
    expect(document.getElementById('host')).toBeNull();

    document.body.innerHTML = '<div id="target"></div>';
    await act(async () => { setState({ tick: getState().tick + 1 }); });
    expect(document.querySelector('#target #host')?.textContent).toBe('hello');
  });

  it('removes its element on unmount', async () => {
    const { unmount } = render(<Anchored id="host" attach={attachToBody}><span>hello</span></Anchored>);
    await act(async () => {});
    await act(async () => { unmount(); });
    expect(document.getElementById('host')).toBeNull();
  });
});
