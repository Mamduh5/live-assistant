export const AVAILABLE_CONNECTORS = Object.freeze(['simulator', 'tikfinity', 'tiktok-browser']);

export function cliOption(name, argumentsAfterScript = process.argv.slice(2)) {
  const namedIndex = argumentsAfterScript.indexOf(name);
  if (namedIndex >= 0) return argumentsAfterScript[namedIndex + 1];
  const assigned = argumentsAfterScript.find((value) => value.startsWith(`${name}=`));
  return assigned?.slice(name.length + 1);
}

export function isAvailableConnector(value) {
  return AVAILABLE_CONNECTORS.includes(value);
}
