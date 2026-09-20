// Builds one self-contained bundle per Lambda function:
//   dist/<function>/index.mjs   (+ index.mjs.map, the source map)
// Terraform zips each dist/<function>/ directory; this script does not create zips.
import { build } from "esbuild";
import { rm, stat } from "node:fs/promises";

const functions = [
  "create-request",
  "list-requests",
  "get-request",
  "enqueuer",
  "delivery-worker",
  "partner-mock",
];

await rm("dist", { recursive: true, force: true });

await Promise.all(
  functions.map((name) =>
    build({
      entryPoints: [`src/handlers/${name}.ts`],
      outfile: `dist/${name}/index.mjs`, // the Lambda handler is "index.handler"
      bundle: true, // inline every import, node_modules included
      platform: "node",
      format: "esm", // .mjs; lets the code use top-level module state and `import`
      target: "node24", // the Lambda runtime is nodejs24.x
      // For platform "node" esbuild prefers the CommonJS entry ("main") of a package. The AWS
      // SDK's CommonJS build calls require("node:https") and friends, which does not work
      // inside an ES module bundle ("Dynamic require of node:https is not supported").
      // Preferring the ESM entry ("module") avoids that and also lets esbuild drop unused code.
      mainFields: ["module", "main"],
      sourcemap: true, // readable stack traces (needs NODE_OPTIONS=--enable-source-maps)
      // Smaller code means less to download and parse on a cold start (about half the size
      // of the unminified bundle). The source map keeps stack traces readable.
      minify: true,
      // Minifying renames classes. keepNames preserves their `name`, so the error type the
      // handler wrapper logs (`errorName`) stays readable in CloudWatch.
      keepNames: true,
      // The AWS SDK is bundled too (not left external). The runtime ships an SDK as well,
      // but AWS advises shipping your own version, so upgrades happen when we choose.
      logLevel: "warning",
    }),
  ),
);

for (const name of functions) {
  const { size } = await stat(`dist/${name}/index.mjs`);
  console.log(`dist/${name}/index.mjs  ${(size / 1024).toFixed(0)} KiB`);
}
