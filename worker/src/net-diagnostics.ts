const DIAGNOSTIC_BODY_LIMIT = 500;

const DIAGNOSTIC_HEADERS = [
  "server",
  "cf-ray",
  "cf-cache-status",
  "via",
  "x-request-id",
  "x-trace-id",
];

const PROXY_ENV_NAMES = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY",
];

export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function describeProxyEnv(env: Record<string, string | undefined> = Bun.env): string {
  const entries = PROXY_ENV_NAMES
    .map((name) => {
      const value = env[name];
      return value ? `${name}=${redactProxyUrl(value)}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));

  return entries.length > 0 ? entries.join(", ") : "none";
}

export async function describeHttpFailure(url: string, response: Response): Promise<string> {
  const headers = describeDiagnosticHeaders(response.headers);
  const body = await readResponseSnippet(response);
  const parts = [
    `url=${describeUrl(url)}`,
    `status=${response.status}`,
    `proxy=${describeProxyEnv()}`,
  ];

  if (headers) parts.push(`headers=${headers}`);
  if (body) parts.push(`body=${JSON.stringify(body)}`);

  return parts.join(" ");
}

export function describeFetchError(url: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return [
    `url=${describeUrl(url)}`,
    `proxy=${describeProxyEnv()}`,
    `error=${JSON.stringify(message)}`,
  ].join(" ");
}

function describeDiagnosticHeaders(headers: Headers): string {
  const entries = DIAGNOSTIC_HEADERS
    .map((name) => {
      const value = headers.get(name);
      return value ? `${name}:${value}` : null;
    })
    .filter((entry): entry is string => Boolean(entry));

  return entries.join(",");
}

async function readResponseSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > DIAGNOSTIC_BODY_LIMIT
      ? `${text.slice(0, DIAGNOSTIC_BODY_LIMIT)}...`
      : text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `<failed to read response body: ${message}>`;
  }
}

function redactProxyUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = "<redacted>";
      parsed.password = "<redacted>";
    }
    return parsed.toString();
  } catch {
    return value;
  }
}
