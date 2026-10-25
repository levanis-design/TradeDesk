'use strict';

// A file URL has an opaque origin. Require the exact document and the current
// window's main frame; a matching URL in another window is not sufficient.
function trustedSender(event, window, documentUrl) {
  if (!window || window.isDestroyed()) return false;
  const contents = window.webContents;
  const frame = event && event.senderFrame;
  return !!frame && event.sender === contents && frame === contents.mainFrame && frame.url === documentUrl;
}

// Python and its libraries must not inherit unrelated credentials, tracing
// configuration, import hooks or provider endpoint overrides from the desktop.
function engineEnvironment(parent, extra = {}) {
  const allowed = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE',
    'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'LANG', 'LC_ALL',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  ]);
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => allowed.has(key.toUpperCase())));
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', ...extra };
}

module.exports = { trustedSender, engineEnvironment };
