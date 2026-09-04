import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });

function pack(destination) {
  const output = run(npm, [
    "pack",
    "--pack-destination",
    destination,
    "--json",
  ]);
  const result = JSON.parse(output);
  if (!Array.isArray(result) || typeof result[0]?.filename !== "string")
    throw new Error("npm pack returned no archive");
  return join(destination, result[0].filename);
}

const firstDirectory = mkdtempSync(join(tmpdir(), "ntig-pack-"));
const secondDirectory = mkdtempSync(join(tmpdir(), "ntig-pack-"));
const consumer = mkdtempSync(join(tmpdir(), "ntig-consumer-"));
try {
  const firstArchive = pack(firstDirectory);
  const secondArchive = pack(secondDirectory);
  if (!readFileSync(firstArchive).equals(readFileSync(secondArchive)))
    throw new Error("npm package archive is not reproducible");

  run(npm, ["init", "--yes"], consumer);
  run(npm, ["install", firstArchive], consumer);
  const library = join(consumer, "node_modules/ntig/dist/library");
  const maps = readdirSync(library, { recursive: true }).filter((name) =>
    name.endsWith(".js.map"),
  );
  if (!maps.length) throw new Error("package contains no source maps");
  for (const name of maps) {
    const map = JSON.parse(readFileSync(join(library, name), "utf8"));
    if (
      !Array.isArray(map.sources) ||
      !Array.isArray(map.sourcesContent) ||
      map.sources.length !== map.sourcesContent.length ||
      map.sourcesContent.some(
        (source) => typeof source !== "string" || source.length === 0,
      )
    )
      throw new Error(`package source map lacks embedded sources: ${name}`);
  }
  const nodeCheck = join(consumer, "check.mjs");
  writeFileSync(
    nodeCheck,
    'import { MemoryStore, NativeGitEngine, createAcceptedStateRepository, MeteredObjectStore } from "ntig";\nif (![MemoryStore, NativeGitEngine, createAcceptedStateRepository, MeteredObjectStore].every(Boolean)) throw new Error("missing export");\n',
  );
  run(node, [nodeCheck], consumer);

  const typeCheck = join(consumer, "check.mts");
  writeFileSync(
    typeCheck,
    'import { MemoryStore, type GitRepository, type ObjectStore } from "ntig";\nconst store: ObjectStore = new MemoryStore();\ndeclare const repo: GitRepository;\nvoid store;\nvoid repo;\n',
  );
  run(
    node,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--strict",
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2023",
      typeCheck,
    ],
    consumer,
  );
  console.log(
    "package consumer, embedded source maps and reproducibility checks passed",
  );
} finally {
  for (const directory of [firstDirectory, secondDirectory, consumer])
    rmSync(directory, { force: true, recursive: true });
}
