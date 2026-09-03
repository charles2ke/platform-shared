export const noopLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {}
});

export function createConsoleLogger(consoleLike = console) {
  return {
    debug: consoleLike.debug?.bind(consoleLike) ?? consoleLike.log.bind(consoleLike),
    info: consoleLike.info?.bind(consoleLike) ?? consoleLike.log.bind(consoleLike),
    warn: consoleLike.warn?.bind(consoleLike) ?? consoleLike.log.bind(consoleLike),
    error: consoleLike.error?.bind(consoleLike) ?? consoleLike.log.bind(consoleLike)
  };
}
