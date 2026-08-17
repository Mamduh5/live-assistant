export function createJsonLogger(write = (line) => console.log(line), clock = () => new Date()) {
  function log(level, message, fields = {}) {
    write(JSON.stringify({
      timestamp: clock().toISOString(),
      level,
      message,
      ...fields,
    }));
  }

  return {
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

