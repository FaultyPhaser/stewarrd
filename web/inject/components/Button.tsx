import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { errorMessage } from '../../shared/format';
import { refreshAll } from '../store';

interface Props {
  onClick: () => Promise<unknown> | unknown;
  disabled?: boolean;
  small?: boolean;
  children: ComponentChildren;
}

/** Runs the action, shows a failure in an alert (as before), then reloads the balance and every list. */
export function Button({ onClick, disabled = false, small = false, children }: Props) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    setBusy(true);
    try {
      await onClick();
    } catch (err) {
      window.alert(errorMessage(err));
    } finally {
      setBusy(false);
      void refreshAll();
    }
  };
  return (
    <button type="button" class={`sc-btn${small ? ' sc-btn--small' : ''}`} disabled={disabled || busy} onClick={click}>
      {children}
    </button>
  );
}

export const Note = ({ warn = false, children }: { warn?: boolean; children: ComponentChildren }) => (
  <div class={`sc-note${warn ? ' sc-note--warn' : ''}`}>{children}</div>
);
