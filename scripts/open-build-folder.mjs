import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";

const buildFolder = resolve("src-tauri/target/release/bundle");

if (!existsSync(buildFolder)) {
  throw new Error(`Build folder does not exist: ${buildFolder}`);
}

execFile("explorer.exe", [buildFolder], (error) => {
  if (error) {
    throw error;
  }
});
