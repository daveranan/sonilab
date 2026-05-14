import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = process.env.AUDIOWAVEFORM_PATH;
const sidecarDir = path.resolve("src-tauri", "bin");
const sidecarName = process.platform === "win32" ? "audiowaveform.exe" : "audiowaveform";
const sidecarPath = path.join(sidecarDir, sidecarName);

if (!source) {
  console.error(`Set AUDIOWAVEFORM_PATH to the ${sidecarName} binary to stage.`);
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`audiowaveform source not found: ${source}`);
  process.exit(1);
}

const validation = spawnSync(source, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});

if (validation.error || validation.status !== 0) {
  console.error(`audiowaveform validation failed for ${source}.`);
  process.exit(1);
}

mkdirSync(sidecarDir, { recursive: true });
copyFileSync(source, sidecarPath);

const output = `${validation.stdout}\n${validation.stderr}`.trim();
console.log(`Staged audiowaveform sidecar at ${sidecarPath}. ${output}`);
