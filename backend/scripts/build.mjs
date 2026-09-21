// Builds one self-contained bundle per Lambda function:
//   dist/<function>/index.mjs   (+ index.mjs.map, the source map)
// Terraform zips each dist/<function>/ directory; this script does not create zips.
//
// The functions that check XML against a schema (only the delivery-worker) get two more
// things in their directory, see `validatesXml` below:
//   dist/<function>/schemas/*.xsd                the sender's own copy of contracts/xsd/
//   dist/<function>/node_modules/xmllint-wasm/   the XSD validator, NOT bundled
import { build } from "esbuild";
import { cp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const functions = [
  "create-request",
  "list-requests",
  "get-request",
  "get-exchange",
  "enqueuer",
  "delivery-worker",
];

// Functions that validate XML. get-exchange only hands a stored record back, so it needs
// neither the schemas nor the validator.
const validatesXml = ["delivery-worker"];

// xmllint-wasm (libxml2 compiled to WebAssembly) cannot go into a bundle. For every
// validation it starts a worker thread from a script FILE and reads its `.wasm` file, and
// it finds both through `__dirname`, that is, next to itself on disk. Bundled into
// index.mjs it fails with "Dynamic require of "worker_threads" is not supported" (an ES
// module has no require and no __dirname). So the bundle keeps the `import` as it is
// (`external`), and the package is copied to dist/<function>/node_modules/, where Node
// finds it by the usual lookup, next to index.mjs.
const EXTERNAL_PACKAGE = "xmllint-wasm";

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
}

for (const name of functions) {
  const { size } = await stat(`dist/${name}/index.mjs`);
  console.log(`dist/${name}/index.mjs  ${(size / 1024).toFixed(0)} KiB`);
}
