const {
  buildAuthUrl,
  handleCallback,
  getConnectionStatus,
  disconnect,
} = require('../dist/services/ebay/ebayAuth.service.js');

async function ebayConnectionStatus(userId) {
  return getConnectionStatus(userId);
}

async function ebayConnectStart(userId) {
  const authUrl = buildAuthUrl(userId);
  return { authUrl };
}

async function ebayReconnectStart(userId) {
  await disconnect(userId);
  const authUrl = buildAuthUrl(userId);
  return { authUrl, reconnected: true };
}

async function ebayDisconnect(userId) {
  await disconnect(userId);
  return { success: true };
}

async function ebayConnectCallback(code, state) {
  return handleCallback(code, state);
}

module.exports = {
  ebayConnectionStatus,
  ebayConnectStart,
  ebayReconnectStart,
  ebayDisconnect,
  ebayConnectCallback,
};
