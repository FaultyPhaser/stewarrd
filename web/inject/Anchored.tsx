import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import { useStore } from './store';

/**
 * Renders children into an element we own inside Seerr's page. Seerr re-renders its own DOM, which can drop our
 * element, so on every DOM tick we check it is still attached and recreate it when it is not.
 * `attach` places a fresh element and returns false when there is nowhere to put it (yet).
 */
export function Anchored({ id, tag = 'div', attach, children }: {
  id: string;
  tag?: string;
  attach: (node: HTMLElement) => boolean;
  children: ComponentChildren;
}) {
  const { tick } = useStore();
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let el = document.getElementById(id);
    if (!el?.isConnected) {
      el = document.createElement(tag);
      el.id = id;
      if (!attach(el)) el = null;
    }
    setNode(el);
  }, [tick]);
  useEffect(() => () => { document.getElementById(id)?.remove(); }, []);
  return node ? createPortal(<>{children}</>, node) : null;
}
