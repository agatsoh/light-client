/*
 * The naming of the message enumerations follows **who** is sending the
 * message. Also is it required to assign actual values to the messages to make
 * it work correctly within the service worker.
 */

export enum ServiceWorkerMessages {
  INSTALLATION_ERROR = 'installation_error',
  RELOAD_WINDOW = 'reload_window',
  CACHE_IS_INVALID = 'cache_is_invalid',
}

export enum ServiceWorkerAssistantMessages {
  UPDATE = 'update',
  VERIFY_CACHE = 'verify_cache',
}
