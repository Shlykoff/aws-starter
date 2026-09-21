// Builds one self-contained bundle per Lambda function:
//   dist/<function>/index.mjs   (+ index.mjs.map, the source map)
// Terraform zips each dist/<function>/ directory; this script does not create zips.
//
// The functions that check XML against a schema (the delivery-worker and the receive-webhook)
// get two more things in their directory, see `validatesXml` below:
//   dist/<function>/schemas/*.xsd                the sender's own copy of contracts/xsd/
//   dist/<function>/node_modules/xmllint-wasm/   the XSD validator, NOT bundled
import { build } from "esbuild";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const functions = [
  "create-request",
  "list-requests",
  "get-request",
  "retry-request",
  "get-exchange",
  "enqueuer",
  "delivery-worker",
  "receive-webhook",
  "log-archiver",
];

// Functions that validate XML. get-exchange only hands a stored record back, so it needs
// neither the schemas nor the validator.
const validatesXml = ["delivery-worker", "receive-webhook"];

// xmllint-wasm (libxml2 compiled to WebAssembly) cannot go into a bundle. For every
// validation it starts a worker thread from a script FILE and reads its `.wasm` file, and
// it finds both through `__dirname`, that is, next to itself on disk. Bundled into
// index.mjs it fails with "Dynamic require of "worker_threads" is not supported" (an ES
// module has no require and no __dirname). So the bundle keeps the `import` as it is
// (`external`), and the package is copied to dist/<function>/node_modules/, where Node
// finds it by the usual lookup, next to index.mjs.
const EXTERNAL_PACKAGE = "xmllint-wasm";

// xmllint-wasm starts a new worker thread for every check. A worker thread obeys the NODE_OPTIONS
// of its process, and the OpenTelemetry layer puts `--import` there (infra/envs/dev/tracing.tf):
// every check would then start the whole tracing SDK again, about 0.3 s on a laptop and about a
// second and 100 MB on Lambda (measured). The copy of the package below is changed so that its
// worker starts with empty NODE_OPTIONS: one line, and the build fails if the line is not there
// any more (a new version of the package), so the change cannot be lost silently.
const WORKER_START = "new Worker(require('path').resolve(__dirname, './xmllint-node.js'))";
const WORKER_START_WITHOUT_LAYER =
  "new Worker(require('path').resolve(__dirname, './xmllint-node.js'), { env: { ...process.env, NODE_OPTIONS: '' } })";

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
      // inside an ES module bundle ("Dynamic require of "node:https" is not supported").
      // Preferring the ESM entry ("module") avoids that and also lets esbuild drop unused code.
      mainFields: ["module", "main"],
      external: validatesXml.includes(name) ? [EXTERNAL_PACKAGE] : [],
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

// The files that sit next to the bundle of a function that validates XML.
const require = createRequire(import.meta.url);
const xmllintDirectory = dirname(require.resolve(`${EXTERNAL_PACKAGE}/package.json`));
for (const name of validatesXml) {
  // The contract, copied from the one place it lives. index.mjs reads it at start-up from
  // `./schemas/` (src/lib/schemas-location.ts).
  await cp("../contracts/xsd", `dist/${name}/schemas`, { recursive: true });
  // The whole package: it is small (under 1 MB), and a copy of the folder cannot miss a file
  // that a new version of the package starts to need.
  await cp(xmllintDirectory, `dist/${name}/node_modules/${EXTERNAL_PACKAGE}`, { recursive: true });

  const entry = `dist/${name}/node_modules/${EXTERNAL_PACKAGE}/index-node.js`;
  const source = await readFile(entry, "utf8");
  if (!source.includes(WORKER_START)) {
    throw new Error(`${EXTERNAL_PACKAGE} no longer starts its worker with: ${WORKER_START}. Update WORKER_START in scripts/build.mjs.`);
  }
  await writeFile(entry, source.replace(WORKER_START, WORKER_START_WITHOUT_LAYER));
}

for (const name of functions) {
  const { size } = await stat(`dist/${name}/index.mjs`);
  console.log(`dist/${name}/index.mjs  ${(size / 1024).toFixed(0)} KiB`);
}
