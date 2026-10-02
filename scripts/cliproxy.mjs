// Seelie's models on a dev machine: runs CLIProxyAPI from .cliproxy/ (gitignored), the way
// the cliproxy service runs it on the ThinkPad.
//   npm run cliproxy
// The first time, put the release for this machine (github.com/router-for-me/CLIProxyAPI/
// releases, the version infra/compose.yml pins) in .cliproxy/bin/, and set CLIPROXY_URL,
// CLIPROXY_API_KEY and CLIPROXY_MANAGEMENT_KEY in .env.local; this writes .cliproxy/config.yaml
// from them. After that the config is the proxy's own (it hashes the management key in place).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", ".cliproxy");
const bin = join(dir, "bin", process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api");
const config = join(dir, "config.yaml");

if (!existsSync(bin)) {
  console.error(`No CLIProxyAPI at ${bin}.\nDownload the release for this machine from https://github.com/router-for-me/CLIProxyAPI/releases and extract it there.`);
  process.exit(1);
}

if (!existsSync(config)) {
  const apiKey = process.env.CLIPROXY_API_KEY?.trim();
  const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY?.trim();
  if (!apiKey || !managementKey) {
    console.error("Set CLIPROXY_API_KEY and CLIPROXY_MANAGEMENT_KEY in .env.local first (openssl rand -hex 24, each).");
    process.exit(1);
  }
  const port = new URL(process.env.CLIPROXY_URL || "http://127.0.0.1:8317").port || "8317";
  mkdirSync(join(dir, "auths"), { recursive: true });
  writeFileSync(
    config,
    [
      "config-version: 8",
      "server:",
      '  host: "127.0.0.1"',
      `  port: ${port}`,
      "management:",
      "  allow-remote: false",
      `  secret-key: ${JSON.stringify(managementKey)}`,
      "  disable-control-panel: true",
      "  disable-auto-update-panel: true",
      "access:",
      "  api-keys:",
      `    - ${JSON.stringify(apiKey)}`,
      "routing:",
      '  strategy: "fill-first"',
      "oauth:",
      '  auth-dir: "./auths"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  console.log("Wrote .cliproxy/config.yaml from .env.local.");
}

const proxy = spawn(bin, ["-config", config], { cwd: dir, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => proxy.kill(signal));
proxy.on("exit", (code) => process.exit(code ?? 0));
