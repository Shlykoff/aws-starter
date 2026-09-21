// Where the XSD files are at run time: the `schemas/` folder next to the bundle. The build
// copies contracts/xsd/ there (scripts/build.mjs), so a function that validates XML carries
// its own copy of the contract. In the bundle, `import.meta.url` is the address of
// dist/delivery-worker/index.mjs, so this is dist/delivery-worker/schemas/.
//
// It is a module of its own only so that the tests can point it at contracts/xsd/ itself
// (they replace this one module; see test/handlers/delivery-worker.test.ts).
export const SCHEMAS_DIRECTORY = new URL("./schemas/", import.meta.url);
