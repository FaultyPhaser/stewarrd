import { render } from 'preact';
import { loadStyles } from './assets';
import { BlockModal, installRequestGuard } from './components/BlockModal';
import { Drawer } from './components/Drawer';
import { MediaPanel } from './components/MediaPanel';
import { startRouter } from './router';
import { refreshMe } from './store';
import './inject.css';

function Root() {
  return (
    <>
      <MediaPanel />
      <Drawer />
      <BlockModal />
    </>
  );
}

loadStyles();

const mount = document.createElement('div');
mount.id = 'sidecar-root';
document.body.appendChild(mount);
render(<Root />, mount);

installRequestGuard();
startRouter();
void refreshMe();
