import { lookup } from "node:dns/promises";
import { getConfig } from "../src/config";
import { describeHttpFailure, describeProxyEnv, describeUrl } from "../src/net-diagnostics";

async function main(): Promise<void> {
  const config = getConfig();
  const pendingUrl = `${config.cloudUrl}/agent/tasks/pending`;
  const host = new URL(config.cloudUrl).hostname;

  console.log(`[healthcheck] target=${describeUrl(pendingUrl)}`);
  console.log(`[healthcheck] proxy=${describeProxyEnv()}`);
  await printDns(host);
  await printFetch("without auth", pendingUrl);
  await printFetch("with auth", pendingUrl, config.agentApiToken);
}

async function printDns(host: string): Promise<void> {
  try {
    const addresses = await lookup(host, { all: true });
    const summary = addresses.map((entry) => `${entry.address}/ipv${entry.family}`).join(", ");
    console.log(`[healthcheck] dns=${summary || "empty"}`);
  } catch (err) {
    console.log(`[healthcheck] dns_error=${formatError(err)}`);
  }
}

async function printFetch(label: string, url: string, token?: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    const elapsedMs = Date.now() - startedAt;

    if (response.ok) {
      const body = await response.text();
      console.log(`[healthcheck] ${label}: status=${response.status} elapsed=${elapsedMs}ms body=${JSON.stringify(body.slice(0, 500))}`);
      return;
    }

    console.log(`[healthcheck] ${label}: elapsed=${elapsedMs}ms ${await describeHttpFailure(url, response)}`);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.log(`[healthcheck] ${label}: elapsed=${elapsedMs}ms error=${formatError(err)}`);
  }
}

function formatError(err: unknown): string {
  return JSON.stringify(err instanceof Error ? err.message : String(err));
}

main().catch((err) => {
  console.error(`[healthcheck] fatal=${formatError(err)}`);
  process.exit(1);
});
