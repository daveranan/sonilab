import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;

if (!repository) throw new Error("GITHUB_REPOSITORY is required.");
if (!tag) throw new Error("GITHUB_REF_NAME is required.");

const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const version = config.version;
const nsisDir = "src-tauri/target/release/bundle/nsis";
const entries = await readdir(nsisDir);
const setupName = entries.find(
  (entry) => entry.includes(`_${version}_`) && entry.endsWith("_x64-setup.exe"),
);

if (!setupName) {
  throw new Error(`No NSIS setup.exe found for version ${version} in ${nsisDir}.`);
}

const sigPath = join(nsisDir, `${setupName}.sig`);
const signature = (await readFile(sigPath, "utf8")).trim();
const releaseAssetName = basename(setupName).replaceAll(" ", ".");
const url = `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(
  releaseAssetName,
)}`;

const latest = {
  version,
  notes: `Sonilabs Sound Library Processor ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url,
    },
  },
};

await writeFile(
  "src-tauri/target/release/bundle/latest.json",
  `${JSON.stringify(latest, null, 2)}\n`,
);

console.log(`Wrote latest.json for ${version}: ${url}`);
