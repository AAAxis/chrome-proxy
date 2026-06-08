// FoxyWall Proxy — authenticated HTTP proxy client.
// Proxy: Xray `http` inbound on the VPN server (port 1080, user/pass auth).
// Chrome supplies credentials via webRequest.onAuthRequired (HTTP proxies only —
// Chrome cannot authenticate SOCKS5, which is why the inbound is HTTP).
// License: account code (VPN-XXXX-XXXX-XXXX) checked against Supabase get_entitlement
// before the proxy can be enabled. See entitlement.js.

importScripts('entitlement.js');

// Proxy credentials are NOT hardcoded. They are fetched from Supabase
// (get_proxy_credentials) at connect-time — only Pro accounts get them — and held
// in chrome.storage.session, which is in-memory and never written to disk.
const CREDS_KEY = 'proxyCreds'; // { host, port, username, password }

async function getCreds() {
  const r = await chrome.storage.session.get([CREDS_KEY]);
  return r[CREDS_KEY] || null;
}
async function setCreds(c) {
  await chrome.storage.session.set({ [CREDS_KEY]: c });
}
async function clearCreds() {
  await chrome.storage.session.remove(CREDS_KEY);
}

function proxyConfigFor(creds) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: 'http', host: creds.host, port: creds.port },
      bypassList: ['localhost', '127.0.0.1'],
    },
  };
}

// ---------------------------------------------------------------------------
// Proxy auth. MV3: listener MUST be registered synchronously at top level so
// the service worker re-registers it on every wake. Credentials are read from
// session storage (populated at connect). Track request IDs to avoid an infinite
// challenge loop if the server rejects them.
// ---------------------------------------------------------------------------
const answeredAuthRequests = new Set();

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    (async () => {
      const creds = await getCreds();
      const isOurProxy =
        details.isProxy &&
        creds &&
        details.challenger &&
        details.challenger.host === creds.host &&
        details.challenger.port === creds.port;

      if (!isOurProxy) {
        callback({});
        return;
      }

      if (answeredAuthRequests.has(details.requestId)) {
        // Credentials already supplied once and rejected — don't loop.
        console.warn('Proxy rejected credentials for request', details.requestId);
        callback({ cancel: true });
        return;
      }

      answeredAuthRequests.add(details.requestId);
      callback({
        authCredentials: { username: creds.username, password: creds.password },
      });
    })();
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

chrome.webRequest.onCompleted.addListener(
  (details) => answeredAuthRequests.delete(details.requestId),
  { urls: ['<all_urls>'] }
);
chrome.webRequest.onErrorOccurred.addListener(
  (details) => answeredAuthRequests.delete(details.requestId),
  { urls: ['<all_urls>'] }
);

// ---------------------------------------------------------------------------
// Proxy control
// ---------------------------------------------------------------------------
async function connectProxy() {
  // Account is auto-created; the proxy credentials themselves are the entitlement
  // check — Supabase only returns them to active Pro accounts.
  const accountId = await fwEnsureAccount();
  if (!accountId) {
    return {
      success: false,
      code: 'NETWORK',
      error: 'Could not reach the license server. Check your connection.',
    };
  }

  // Selected country (Pro only). Free accounts auto-use the default server —
  // the server id is ignored server-side for them.
  const { selectedServerId } = await chrome.storage.local.get(['selectedServerId']);

  let creds;
  try {
    creds = await fwGetProxyCredentials(accountId, selectedServerId || null);
  } catch (e) {
    return {
      success: false,
      code: 'NETWORK',
      error: 'Could not reach the license server. Check your connection.',
    };
  }

  if (!creds.authorized) {
    // With free tier allowed, this only happens for unknown accounts or no servers.
    const code = creds.reason === 'not_found' ? 'LICENSE_INVALID' : 'UNAVAILABLE';
    const error =
      creds.reason === 'not_found'
        ? 'Account not recognised. Try reopening the panel.'
        : 'No proxy server is available right now.';
    return { success: false, code, error };
  }

  await setCreds({
    host: creds.host,
    port: creds.port,
    username: creds.username,
    password: creds.password,
  });
  await chrome.proxy.settings.set({ value: proxyConfigFor(creds), scope: 'regular' });
  await chrome.storage.local.set({
    isConnected: true,
    connectedServer: {
      id: creds.server_id,
      country: creds.country,
      country_code: creds.country_code,
      city: creds.city,
    },
  });
  console.log('Proxy connected:', creds.country, `${creds.host}:${creds.port}`);
  return { success: true, server: creds.server_id, country: creds.country };
}

async function disconnectProxy() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
  await clearCreds();
  await chrome.storage.local.set({ isConnected: false });
  console.log('Proxy disconnected');
  return { success: true };
}

async function getStatus() {
  const r = await chrome.storage.local.get(['isConnected']);
  return { success: true, isConnected: r.isConnected || false };
}

// On service worker start, re-assert proxy settings to match stored state
// (Chrome keeps proxy settings across restarts, but make state consistent).
async function syncStateOnStartup() {
  try {
    const { isConnected } = await chrome.storage.local.get(['isConnected']);

    if (isConnected) {
      // storage.session is cleared on browser restart, so the credentials needed
      // to answer the proxy's auth challenge may be gone even though the proxy
      // setting persisted. Re-fetch (also re-validates the license); if that fails,
      // tear down so we never sit on a dead authenticated proxy.
      const creds = await getCreds();
      if (!creds) {
        const result = await connectProxy();
        if (!result.success) {
          await disconnectProxy();
        }
      }
    } else {
      // Make sure no stale proxy setting survives a "disconnected" state.
      const current = await chrome.proxy.settings.get({});
      const isSet =
        current.value && current.value.mode === 'fixed_servers' &&
        current.levelOfControl === 'controlled_by_this_extension';
      if (isSet) await chrome.proxy.settings.clear({ scope: 'regular' });
    }
  } catch (e) {
    console.error('State sync failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Messages from popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'getSettings': {
          const status = await getStatus();
          sendResponse({
            success: true,
            settings: { isProxyEnabled: status.isConnected },
          });
          break;
        }

        case 'toggleProxy': {
          const result = message.enabled
            ? await connectProxy()
            : await disconnectProxy();
          sendResponse(result);
          break;
        }

        case 'getLicense': {
          // Auto-create the account on first open (desktop-style, no activation step).
          const accountId = await fwEnsureAccount();
          const ent = await fwGetEntitlement(accountId);
          sendResponse({ success: true, accountId, entitlement: ent });
          break;
        }

        case 'setAccountId': {
          // Restore / apply an existing Pro code (from desktop or a purchase).
          const id = (message.accountId || '').trim().toUpperCase();
          await fwSetAccountId(id);
          const ent = await fwGetEntitlement(id);
          sendResponse({ success: true, accountId: id, entitlement: ent });
          break;
        }

        case 'getServers': {
          const accountId = await fwEnsureAccount();
          const list = await fwListServers(accountId);
          const { selectedServerId } = await chrome.storage.local.get(['selectedServerId']);
          sendResponse({ success: true, ...list, selectedServerId: selectedServerId || null });
          break;
        }

        case 'setServer': {
          // Persist the chosen country. Only meaningful for Pro; harmless for free
          // (server-side forces the default regardless).
          await chrome.storage.local.set({ selectedServerId: message.serverId || null });
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true; // async sendResponse
});

// Open the side panel when the toolbar icon is clicked (MetaMask-style panel).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('setPanelBehavior failed:', e));
}

chrome.runtime.onStartup.addListener(syncStateOnStartup);
chrome.runtime.onInstalled.addListener(syncStateOnStartup);
