import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "dist/worker.js");
await mkdir(dirname(out), { recursive: true });
const result = await build({
  entryPoints: ["src/worker.ts"],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: false,
  metafile: true,
});
const forbidden = Object.keys(result.metafile.inputs).filter((path) =>
  /(?:^|\/)node:|(?:child_process|node_modules\/(?:miniflare|wrangler)\/)/.test(
    path,
  ),
);
if (
  forbidden.length ||
  Object.values(result.metafile.outputs).some((output) => output.imports.length)
) {
  throw new Error(
    "Worker bundle must be self-contained and exclude native test tools",
  );
}
console.log(out);
