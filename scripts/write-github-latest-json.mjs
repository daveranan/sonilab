import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const outputPath = process.argv[2] ?? "src-tauri/target/release/bundle/latest.json";
const searchRoots = process.argv.slice(3);

if (!repository) throw new Error("GITHUB_REPOSITORY is required.");
if (!tag) throw new Error("GITHUB_REF_NAME is required.");

const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
const tagVersion = tag.match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)?.[1];
const version = tagVersion ?? config.version;
const roots = searchRoots.length > 0 ? searchRoots : ["src-tauri/target/release/bundle"];

async function listFiles(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];

  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => listFiles(join(path, entry.name))),
  );
  return files.flat();
}

function releaseUrl(filePath) {
  const releaseAssetName = basename(filePath).replaceAll(" ", ".");
  return `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(
    releaseAssetName,
  )}`;
}

async function signedPlatform(filePath) {
  const signature = (await readFile(`${filePath}.sig`, "utf8")).trim();
  return {
    signature,
    url: releaseUrl(filePath),
  };
}

const files = (await Promise.all(roots.map((root) => listFiles(root)))).flat();
const normalized = (filePath) => filePath.split(sep).join("/");
const platforms = {};

const windowsSetup = files.find(
  (filePath) =>
    basename(filePath).includes(`_${version}_`) &&
    basename(filePath).endsWith("_x64-setup.exe"),
);

if (windowsSetup) {
  platforms["windows-x86_64"] = await signedPlatform(windowsSetup);
}

for (const filePath of files.filter((file) => file.endsWith(".app.tar.gz"))) {
  const path = normalized(relative(process.cwd(), filePath)).toLowerCase();

  if (path.includes("arm64") || path.includes("aarch64")) {
    platforms["darwin-aarch64"] = await signedPlatform(filePath);
  } else if (path.includes("intel") || path.includes("x86_64")) {
    platforms["darwin-x86_64"] = await signedPlatform(filePath);
  }
}

if (Object.keys(platforms).length === 0) {
  throw new Error(`No signed updater artifacts found for version ${version}.`);
}

const latest = {
  version,
  notes: `Sonilabs Sound Library Processor ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(latest, null, 2)}\n`);

console.log(
  `Wrote latest.json for ${version}: ${Object.keys(platforms).join(", ")}`,
);
