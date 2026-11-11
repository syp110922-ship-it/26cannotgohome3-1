'use strict';

const { loadConfig } = require('./config');
const { createDatabase } = require('./db');
const { PinAttemptGuard } = require('./auth');
const { createStateMachine } = require('./state');
const { createWebSocketGateway } = require('./ws');
const { createHttpServer } = require('./http');

function createApp(configOverrides = {}) {
  const config = loadConfig(configOverrides);
  const db = createDatabase(config);
  const pinGuard = new PinAttemptGuard({
    maxAttempts: config.pinMaxAttempts,
    lockoutMs: config.pinLockoutMs,
    store: {
      load: () => db.getPinGuardState(),
      save: (state) => db.savePinGuardState(state)
    }
  });

  let stateMachine = null;
  let wsGateway = null;

  const server = createHttpServer({
    config,
    db,
    pinGuard,
    getStateMachine: () => stateMachine,
    onPinChanged: () => wsGateway?.disconnectAll('pin_changed')
  });

  wsGateway = createWebSocketGateway({
    server,
    config,
    db,
    getStateMachine: () => stateMachine
  });

  stateMachine = createStateMachine({
    config,
    db,
    onBroadcast: (snapshot) => wsGateway.broadcastToControl(snapshot),
    onSendToDisplays: (payload, targetId) => wsGateway.sendToDisplays(payload, targetId),
    onCloseDisplaySocket: (id) => wsGateway.closeDisplaySocket(id)
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        resolve({
          host: config.host,
          port: typeof addr === 'object' && addr ? addr.port : config.port
        });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      stateMachine.destroy();
      wsGateway.close();
      server.close(() => {
        db.close();
        resolve();
      });
    });
  }

  return {
    config,
    db,
    pinGuard,
    stateMachine,
    wsGateway,
    server,
    start,
    stop
  };
}

if (require.main === module) {
  const app = createApp();
  app
    .start()
    .then(({ host, port }) => {
      console.log(`[ghost-sync] Server listening on http://${host}:${port}`);
      console.log(
        `[ghost-sync] Required displays: ${app.db.getRequiredDisplays().join(', ')}`
      );
      console.log('[ghost-sync] 3-PIN auth ready (admin/control + display + settings)');
    })
    .catch((err) => {
      console.error('[ghost-sync] Failed to start server:', err);
      process.exit(1);
    });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ghost-sync] Received ${signal}, shutting down...`);
    app.stop().then(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  createApp
};
