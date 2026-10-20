const { ipcRenderer } = require('electron');

// A page gets no Electron API; only genuine clicks on links reach the main process.
function openClickedLink(event) {
  if (!event.isTrusted || event.defaultPrevented) return;
  if (event.type === 'auxclick' && event.button !== 1) return;
  const anchor = event.composedPath().find(element => element instanceof HTMLAnchorElement);
  if (!anchor || anchor.hasAttribute('download')) return;
  let url;
  try { url = new URL(anchor.href, window.location.href); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.origin === window.location.origin) return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.send('sas:open-external', url.href);
}

window.addEventListener('click', openClickedLink, true);
window.addEventListener('auxclick', openClickedLink, true);
