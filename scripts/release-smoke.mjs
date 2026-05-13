import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const packageJson = JSON.parse(read("package.json"));
for (const script of ["format", "lint", "typecheck", "test", "build"]) {
  if (!packageJson.scripts?.[script]) failures.push(`Missing npm script: ${script}`);
}

const appShell = read("src/features/app/shell/AppShell.tsx");
const settings = read("src/features/app/shell/SettingsPanel.tsx");
const toolbar = read("src/features/app/shell/Toolbar.tsx");
if (!appShell.includes("Add a local sound folder"))
  failures.push("First-run local onboarding is missing.");
if (
  appShell.includes("Add Freesound") ||
  settings.includes("Freesound") ||
  toolbar.includes("Freesound")
)
  failures.push("Cloud/Freesound onboarding text is exposed.");
if (!settings.includes("Audio Devices"))
  failures.push("Audio device settings missing.");
if (!settings.includes("Export Defaults")) failures.push("Export defaults UI missing.");
if (!settings.includes("License / Attribution"))
  failures.push("License/attribution report UI missing.");
if (!settings.includes("Updates")) failures.push("Update flow UI missing.");

const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
if (!tauriConfig.bundle?.targets?.includes("nsis"))
  failures.push("NSIS installer target missing.");
if (!tauriConfig.bundle?.targets?.includes("msi"))
  failures.push("MSI installer target missing.");

const signing = spawnSync(process.execPath, ["scripts/check-signing-readiness.mjs"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
if (signing.status !== 0) failures.push(signing.stderr || signing.stdout);
else process.stdout.write(signing.stdout);
if (signing.stderr) process.stderr.write(signing.stderr);

if (failures.length > 0) {
  console.error(failures.map((failure) => `release-smoke: ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Release smoke checks passed.");
