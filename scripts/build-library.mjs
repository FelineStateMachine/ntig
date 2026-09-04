import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = join(root, "dist/library");
// Only remove the validated generated library directory. The Worker build may
// share dist/ and must remain untouched.
rmSync(outputDirectory, { force: true, recursive: true });
const result = spawnSync(
  process.execPath,
  ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);

// TypeScript rewrites emitted JavaScript imports, but declaration imports
// retain the source extension. Rewrite those references so the package is
// consumable without allowImportingTsExtensions and without shipping src/.
function rewrite(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) rewrite(path);
    else if (path.endsWith(".d.ts")) {
      const source = readFileSync(path, "utf8");
      const output = source.replaceAll('.ts"', '.js"');
      if (output !== source) writeFileSync(path, output);
    }
  }
}
rewrite(outputDirectory);
