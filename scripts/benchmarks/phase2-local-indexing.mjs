import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const counts = [10_000, 50_000, 100_000];
const root = path.resolve("benchmark-results", "phase2-indexing-fixtures");
const outputPath = path.resolve("benchmark-results", "phase2-local-indexing.json");
const shouldGenerate = process.argv.includes("--generate");
const shouldClean = process.argv.includes("--clean");

function wavBytes() {
  const buffer = Buffer.alloc(48);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(40, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(48_000, 24);
  buffer.writeUInt32LE(96_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(4, 40);
  return buffer;
}

function generateFixture(count) {
  const directory = path.join(root, `${count}`);
  mkdirSync(directory, { recursive: true });
  const bytes = wavBytes();
  for (let index = 0; index < count; index += 1) {
    const bucket = path.join(
      directory,
      String(Math.floor(index / 1000)).padStart(3, "0"),
    );
    mkdirSync(bucket, { recursive: true });
    writeFileSync(
      path.join(bucket, `short-${String(index).padStart(6, "0")}.wav`),
      bytes,
    );
  }
  return directory;
}

function walk(directory) {
  const stack = [directory];
  let filesSeen = 0;
  let audioCandidates = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        filesSeen += 1;
        if (fullPath.toLowerCase().endsWith(".wav")) {
          audioCandidates += 1;
          statSync(fullPath);
        }
      }
    }
  }
  return { filesSeen, audioCandidates };
}

if (shouldClean && existsSync(root)) {
  rmSync(root, { recursive: true, force: true });
}

mkdirSync(path.dirname(outputPath), { recursive: true });
const cases = counts.map((count) => {
  const directory = path.join(root, `${count}`);
  if (shouldGenerate || !existsSync(directory)) {
    generateFixture(count);
  }
  const startedAt = performance.now();
  const result = walk(directory);
  const durationMs = performance.now() - startedAt;
  return {
    count,
    fixturePath: directory,
    durationMs: Number(durationMs.toFixed(3)),
    filesSeen: result.filesSeen,
    audioCandidates: result.audioCandidates,
    filesPerSecond: Number((result.filesSeen / (durationMs / 1000)).toFixed(2)),
  };
});

writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      phase: "2",
      note: "Synthetic short-file scanner harness. Use --generate to rebuild fixtures, --clean to remove first.",
      cases,
    },
    null,
    2,
  )}\n`,
);
console.log(`Phase 2 indexing benchmark wrote ${outputPath}.`);
