/**
 * The browser entry point, bundled into `dist/web/app.js` (tsup's third
 * entry; add-board-web task 4.1): mounts the app into the element with id
 * `ROOT_ID` of the page, with the browser's own dependencies. Loaded as a
 * module script, so the document is parsed when it runs.
 */

import { ROOT_ID, mount } from './mount.js';

mount(document.getElementById(ROOT_ID));
