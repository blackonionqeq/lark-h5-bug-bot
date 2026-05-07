export function log(scope: string, message: string): void {
  console.log(formatLog(scope, message));
}

export function error(scope: string, message: string): void {
  console.error(formatLog(scope, message));
}

function formatLog(scope: string, message: string): string {
  return `${new Date().toISOString()} [${scope}] ${message}`;
}
