import 'prismjs/themes/prism-tomorrow.css';
import { App } from './store/actions.js';
import { defineApp, ReaderApp } from './ui/app.js';
import { defineNav } from './ui/nav-rail.js';
import { definePane } from './ui/doc-pane.js';
import { defineInspector } from './ui/inspector.js';
import { defineTray } from './ui/review-tray.js';

defineApp();
defineNav();
definePane();
defineInspector();
defineTray();

const root = document.querySelector<ReaderApp>('reader-app')!;
const app = new App();
root.connect(app);
void app.init();
