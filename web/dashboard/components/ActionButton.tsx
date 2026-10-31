import { useState } from 'preact/hooks';
import { errorMessage } from '../../shared/format';
import { useApp } from '../context';

interface Props {
  label: string;
  onClick: () => Promise<void> | void;
  danger?: boolean;
}

/** A table-cell button that disables itself while its action runs and reports failures in the status line. */
export function ActionButton({ label, onClick, danger = false }: Props) {
  const { say } = useApp();
  const [busy, setBusy] = useState(false);
  const click = async () => {
    setBusy(true);
    try {
      await onClick();
    } catch (err) {
      say(errorMessage(err), true);
    } finally {
      setBusy(false);
    }
  };
  return <button type="button" class={danger ? 'danger' : undefined} disabled={busy} onClick={click}>{label}</button>;
}
