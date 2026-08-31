'use strict';

const INTERNET_ERROR_CODE = 'INTERNET_UNAVAILABLE';

const OFFLINE_MESSAGE = 'No internet connection';
const OFFLINE_DETAIL = 'Job Desk cannot reach the internet. Check Wi-Fi, Ethernet, or your VPN, then choose Retry. Your current work will be kept.';
const CONNECTION_MESSAGE = 'Connection problem';
const CONNECTION_DETAIL = 'Job Desk could not reach the online service. Check your connection, then choose Retry. Your current work will be kept.';

const TRANSPORT_CODES = new Set([
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED',
]);

const TRANSPORT_MESSAGE = /fetch failed|network error|network socket|socket hang up|timed out|timeout|dns|name[_ ]not[_ ]resolved|internet[_ ]disconnected|connection[_ ](?:closed|reset|timed[_ ]out)/i;

let connectivityDialog = null;

// A blip — a dropped packet, a DNS hiccup, a VPN reconnect — usually clears
// within a couple of seconds. Asking the person to click Retry for that is
// worse than just trying again ourselves; the popup is for when it's still
// down after several real attempts, not the first stumble.
const AUTO_RETRY_ATTEMPTS = 4;
const AUTO_RETRY_DELAY_MS = 1500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads Electron's system connectivity signal.
 * @return True when a network route may be available, as a Boolean.
 */
function systemIsOnline() {
  return require('electron').net.isOnline();
}

/**
 * Creates a structured error suitable for IPC and a user-facing popup.
 * @param kind Connectivity failure kind, either offline or connection.
 * @param cause Original transport error when one exists.
 * @return Structured connectivity error as an Error.
 */
function createInternetError(kind = 'connection', cause = null) {
  const offline = kind === 'offline';
  const error = new Error(offline ? OFFLINE_DETAIL : CONNECTION_DETAIL, cause ? { cause } : undefined);
  error.code = INTERNET_ERROR_CODE;
  error.popupTitle = offline ? OFFLINE_MESSAGE : CONNECTION_MESSAGE;
  error.popupDetail = error.message;
  return error;
}

/**
 * Returns the current system connectivity state without making a remote request.
 * @param onlineCheck Optional connectivity function used by tests.
 * @return Connectivity status and user-facing text as an Object.
 */
function checkInternet(onlineCheck = systemIsOnline) {
  let online = true;
  try { online = onlineCheck() !== false; } catch { online = true; }
  return online
    ? { online: true, code: null, message: 'Internet connection is available.' }
    : { online: false, code: INTERNET_ERROR_CODE, message: OFFLINE_DETAIL };
}

/**
 * Stops an internet-only operation when the system is definitely offline.
 * @param onlineCheck Optional connectivity function used by tests.
 * @return True when the operation may continue, as a Boolean.
 */
function requireInternet(onlineCheck = systemIsOnline) {
  const status = checkInternet(onlineCheck);
  if (!status.online) throw createInternetError('offline');
  return true;
}

/**
 * Detects low-level transport failures through their cause chain.
 * @param error Error produced by fetch, SMTP, or another network client.
 * @return True when the failure is connectivity-related, as a Boolean.
 */
function isTransportError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code === INTERNET_ERROR_CODE || TRANSPORT_CODES.has(String(current.code || '').toUpperCase())) {
      return true;
    }
    if (TRANSPORT_MESSAGE.test(String(current.message || ''))) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Converts a low-level transport failure into the shared connectivity error.
 * @param error Error produced by an internet-only operation.
 * @return Original or normalised error as an Error.
 */
function normaliseInternetError(error) {
  if (error?.code === INTERNET_ERROR_CODE) return error;
  return isTransportError(error) ? createInternetError('connection', error) : error;
}

/**
 * Shows one shared Retry or Cancel popup for a connectivity failure.
 * @param parent Parent Electron window for the popup.
 * @param error Structured or low-level connectivity error.
 * @return Retry, cancel, or unavailable decision as a Promise of String.
 */
async function showInternetError(parent, error) {
  const shownError = normaliseInternetError(error);
  if (shownError?.code !== INTERNET_ERROR_CODE || !parent || parent.isDestroyed()) return 'unavailable';
  if (!connectivityDialog) {
    const { dialog } = require('electron');
    connectivityDialog = dialog.showMessageBox(parent, {
      type: 'warning',
      title: shownError.popupTitle || CONNECTION_MESSAGE,
      message: shownError.popupTitle || CONNECTION_MESSAGE,
      detail: shownError.popupDetail || shownError.message,
      buttons: ['Retry', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => response === 0 ? 'retry' : 'cancel')
      .finally(() => { connectivityDialog = null; });
  }
  return connectivityDialog;
}

/**
 * Runs an internet-facing action and replays it after a successful Retry.
 * @param action Internet-facing operation to perform.
 * @param options Parent window, popup policy, and injectable test functions.
 * @return Action result as a Promise of its original type.
 */
async function runWithInternet(action, options = {}) {
  const onlineCheck = options.onlineCheck || systemIsOnline;
  const ask = options.ask || showInternetError;
  const autoRetries = options.autoRetries ?? AUTO_RETRY_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? AUTO_RETRY_DELAY_MS;
  while (true) {
    let shownError = null;
    for (let attempt = 0; attempt <= autoRetries; attempt++) {
      try {
        requireInternet(onlineCheck);
        return await action();
      } catch (error) {
        shownError = normaliseInternetError(error);
        if (shownError?.code !== INTERNET_ERROR_CODE) throw shownError;
        if (attempt < autoRetries) await wait(retryDelayMs);
      }
    }
    if (options.popup === false) throw shownError;
    const decision = await ask(options.parent || null, shownError);
    if (decision === 'retry') continue;
    shownError.popupShown = decision === 'cancel';
    throw shownError;
  }
}

module.exports = {
  INTERNET_ERROR_CODE,
  checkInternet,
  requireInternet,
  isTransportError,
  normaliseInternetError,
  showInternetError,
  runWithInternet,
};
