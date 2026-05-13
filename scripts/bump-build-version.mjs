import { readFile, writeFile } from "node:fs/promises";

const dryRun = process.argv.includes("--dry-run");

const jsonFiles = ["package.json", "src-tauri/tauri.conf.json"];

const packageLockPath = "package-lock.json";
const cargoTomlPath = "src-tauri/Cargo.toml";
const cargoLockPath = "src-tauri/Cargo.lock";

function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Expected x.y.z version, got "${version}".`);
  }

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replacePackageVersion(toml, packageName, version) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const packagePattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${escapedName}"\\r?\\nversion = )"[^"]+"`,
    "m",
  );
  if (!packagePattern.test(toml)) {
    throw new Error(`Could not find ${packageName} in Cargo.lock.`);
  }

  return toml.replace(packagePattern, `$1"${version}"`);
}

const tauriConfig = await readJson("src-tauri/tauri.conf.json");
const currentVersion = tauriConfig.version;
const tagVersion =
  process.env.GITHUB_REF_TYPE === "tag"
    ? /^v?(\d+\.\d+\.\d+)$/.exec(process.env.GITHUB_REF_NAME ?? "")?.[1]
    : undefined;
const nextVersion = tagVersion ?? nextPatchVersion(currentVersion);

if (!dryRun) {
  for (const path of jsonFiles) {
    const json = await readJson(path);
    json.version = nextVersion;
    await writeJson(path, json);
  }

  const packageLock = await readJson(packageLockPath);
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
  await writeJson(packageLockPath, packageLock);

  const cargoToml = await readFile(cargoTomlPath, "utf8");
  await writeFile(
    cargoTomlPath,
    cargoToml.replace(/(^version = )"[^"]+"/m, `$1"${nextVersion}"`),
  );

  const packageJson = await readJson("package.json");
  const cargoLock = await readFile(cargoLockPath, "utf8");
  await writeFile(
    cargoLockPath,
    replacePackageVersion(cargoLock, packageJson.name, nextVersion),
  );
}

console.log(`Sonilabs version ${currentVersion} -> ${nextVersion}`);
