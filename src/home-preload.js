// ============================================================================
// home-preload.js — attached to every ordinary tab's WebContentsView (see
// createTab() / restoreDiscardedTab() in main.js), because any such tab can
// be showing home.html right now. A preload script re-runs on every
// navigation of its WebContentsView, so isHomePage() is re-checked each
// time: the privileged window.glozaHome bridge is exposed ONLY while the
// page actually loaded is this app's own home.html. The instant that same
// tab navigates to a real website, this file runs again, isHomePage() is
// false, and nothing is exposed — a real website never gets window.glozaHome
// (or any Electron API) from this tab, exactly as before home.html had a
// preload at all. See the "no preload/Node bridge" rationale this replaces,
// still explained above pushHomeData() in main.js.
//
// This bridge is deliberately narrow: five bookmark-CRUD calls scoped to the
// home-screen collection only (never the toolbar tree, never the filesystem,
// never any other part of the app), plus one push-update subscription.
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

function isHomePage() {
  try {
    const url = new URL(location.href);
    return url.protocol === 'file:' && /(^|\/)home\.html$/.test(url.pathname);
  } catch {
    return false;
  }
}

if (isHomePage()) {
  contextBridge.exposeInMainWorld('glozaHome', {
    list: () => ipcRenderer.invoke('home-bookmarks:list'),
    add: (title, url) => ipcRenderer.invoke('home-bookmarks:add', { title, url }),
    update: (id, changes) => ipcRenderer.invoke('home-bookmarks:update', { id, ...changes }),
    remove: (id) => ipcRenderer.invoke('home-bookmarks:remove', id),
    reorder: (orderedIds) => ipcRenderer.invoke('home-bookmarks:reorder', orderedIds),
    moveToToolbar: (id) => ipcRenderer.invoke('home-bookmarks:moveToToolbar', id),
    // Fires whenever the home-screen collection changes — from this tab's
    // own dialog, from a reverse move initiated on the bookmark toolbar, or
    // from another Gloza window — so every open home tab stays in sync.
    onUpdated: (callback) => {
      ipcRenderer.on('home-bookmarks-updated', (_event, list) => callback(list));
    },
  });
}
