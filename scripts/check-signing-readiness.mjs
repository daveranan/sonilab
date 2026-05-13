import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const configPath = path.join(root, "src-tauri", "tauri.conf.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const windows = config.bundle?.windows ?? {};
const updater = config.plugins?.updater ?? {};
const failures = [];
const warnings = [];

if (!config.bundle?.targets?.includes("nsis")) failures.push("NSIS target missing.");
if (!config.bundle?.targets?.includes("msi")) failures.push("MSI target missing.");
if (windows.digestAlgorithm !== "sha256")
  failures.push("Windows digestAlgorithm must be sha256.");
if (!windows.timestampUrl) failures.push("Windows timestampUrl missing.");
if (windows.allowDowngrades !== false)
  failures.push("Windows allowDowngrades must be false for release builds.");

if (!windows.certificateThumbprint && !windows.signCommand) {
  warnings.push(
    "No certificateThumbprint/signCommand is configured; installer is signing-ready, not signed.",
  );
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  warnings.push("TAURI_SIGNING_PRIVATE_KEY is not set for updater artifact signing.");
}
if (config.bundle?.createUpdaterArtifacts !== true)
  failures.push("bundle.createUpdaterArtifacts must be true.");
if (!updater.pubkey) failures.push("plugins.updater.pubkey is missing.");
if (!Array.isArray(updater.endpoints) || updater.endpoints.length === 0)
  failures.push("plugins.updater.endpoints must include at least one endpoint.");

for (const warning of warnings) console.warn(`signing-readiness: ${warning}`);

if (failures.length > 0) {
  console.error(failures.map((failure) => `signing-readiness: ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Signing readiness checks passed.");
