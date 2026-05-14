import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sidecarName = process.platform === "win32" ? "audiowaveform.exe" : "audiowaveform";
const candidates = [
  process.env.AUDIOWAVEFORM_PATH,
  path.resolve("src-tauri", "bin", sidecarName),
  "audiowaveform",
].filter(Boolean);

for (const candidate of candidates) {
  if (candidate !== "audiowaveform" && !existsSync(candidate)) continue;
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) continue;
  const output = `${result.stdout}\n${result.stderr}`.trim();
  console.log(`audiowaveform found at ${candidate}. ${output}`);
  process.exit(0);
}

console.error(
  `audiowaveform not found. Set AUDIOWAVEFORM_PATH, add audiowaveform to PATH, or place ${sidecarName} in src-tauri/bin.`,
);
process.exit(1);
