(function initGhostConfig() {
  // For Netlify split deployment, set your Oracle VM DuckDNS URL here, e.g.:
  // const PROD_BACKEND_ORIGIN = 'https://your-subdomain.duckdns.org';
  const PROD_BACKEND_ORIGIN = '';
  const STORAGE_KEY = 'ghost_server_origin';

  function validateOrigin(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
      const parsed = new URL(raw.trim());
      const isHttps = parsed.protocol === 'https:';
      const isLocalHttp =
        parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
      if (!isHttps && !isLocalHttp) {
        return null;
      }
      return parsed.origin;
    } catch {
      return null;
    }
  }

  function resolveApiBase() {
    const savedOrigin = validateOrigin(window.localStorage.getItem(STORAGE_KEY));
    if (savedOrigin) return savedOrigin;

    const params = new URLSearchParams(window.location.search);
    const queryOrigin = validateOrigin(params.get('server'));
    if (queryOrigin) return queryOrigin;

    if (
      PROD_BACKEND_ORIGIN &&
      window.location.hostname.endsWith('.netlify.app')
    ) {
      const prod = validateOrigin(PROD_BACKEND_ORIGIN);
      if (prod) return prod;
    }

    return window.location.origin;
  }

  const apiBase = resolveApiBase();
  const wsBase = apiBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');

  window.GHOST_CONFIG = {
    apiBase,
    wsBase,
    wsUrl: `${wsBase}/ws`,
    validateOrigin,
    setServerOrigin(nextOrigin) {
      const valid = validateOrigin(nextOrigin);
      if (!valid) return false;
      window.localStorage.setItem(STORAGE_KEY, valid);
      return true;
    },
    clearServerOrigin() {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  };
})();
