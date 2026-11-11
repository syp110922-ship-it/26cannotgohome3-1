(function initGhostConfig() {
  // For Netlify split deployment, set your Oracle VM DuckDNS URL here, e.g.:
  // const PROD_BACKEND_ORIGIN = 'https://your-subdomain.duckdns.org';
  const PROD_BACKEND_ORIGIN = '';

  const params = new URLSearchParams(window.location.search);
  const queryOrigin = params.get('server');
  const savedOrigin = window.localStorage.getItem('ghost_server_origin');

  let apiBase = window.location.origin;
  if (queryOrigin) {
    apiBase = queryOrigin.replace(/\/+$/, '');
    window.localStorage.setItem('ghost_server_origin', apiBase);
  } else if (savedOrigin) {
    apiBase = savedOrigin.replace(/\/+$/, '');
  } else if (
    PROD_BACKEND_ORIGIN &&
    window.location.hostname.endsWith('.netlify.app')
  ) {
    apiBase = PROD_BACKEND_ORIGIN.replace(/\/+$/, '');
  }

  const wsBase = apiBase.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');

  window.GHOST_CONFIG = {
    apiBase,
    wsBase,
    wsUrl: `${wsBase}/ws`
  };
})();
