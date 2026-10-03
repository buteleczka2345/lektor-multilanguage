import './src/background/background.js';

// ===== Diagnostyka: łap błędy service workera i zapisuj do storage (zobaczysz je w popupie) =====
function _svcErr(tag, err) {
  try {
    const msg = (err && (err.message || err.stack)) || String(err);
    chrome.storage.local.set({ '__svcError': { tag, msg, ts: Date.now() } });
  } catch (_) {}
}
self.addEventListener('error', function (ev) {
  console.error('[LiveDub SW ERR]', ev.message, ev.filename, ev.lineno, ev.error);
  _svcErr('error', ev.error || ev.message);
});
self.addEventListener('unhandledrejection', function (ev) {
  const msg = String((ev.reason && (ev.reason.message || ev.reason)) || ev.reason || '');
  if (msg.includes('Receiving end does not exist')) {
    ev.preventDefault();
    return;
  }
  console.error('[LiveDub SW REJ]', ev.reason);
  _svcErr('rejection', ev.reason);
});

