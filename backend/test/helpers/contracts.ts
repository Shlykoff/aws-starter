import { readFileSync, readdirSync } from "node:fs";
import { XsdXmlValidator } from "../../src/clients/xsd-xml-validator";

// The shared contract of the two sides (contracts/): the schemas and the sample messages.
// The tests read them straight from there, so a change of the contract shows up in the tests
// at once. (In Lambda the schemas are a copy inside the package; see scripts/build.mjs.)
export const CONTRACTS = new URL("../../../contracts/", import.meta.url);
export const XSD_DIRECTORY = new URL("xsd/", CONTRACTS);

/** The real validator: real libxml2 (WebAssembly), real schema files. */
export const createRealValidator = (): XsdXmlValidator => new XsdXmlValidator(XSD_DIRECTORY);

export type FixtureKind = "submission" | "reply" | "event";

/** The text of a fixture, for example fixture("submission", "valid/minimal.xml"). */
export const fixture = (kind: FixtureKind, name: string): string =>
  readFileSync(new URL(`fixtures/${kind}/${name}`, CONTRACTS), "utf8");

/** contracts/fixtures/expected.json: for every fixture, "valid" or the reply code it must produce. */
export const expected = JSON.parse(
  readFileSync(new URL("fixtures/expected.json", CONTRACTS), "utf8"),
) as Record<FixtureKind, Record<string, string>>;

/** Every fixture file on disk, as "valid/minimal.xml", to compare with expected.json. */
export const fixturesOnDisk = (kind: FixtureKind): string[] =>
  ["valid", "invalid"]
    .flatMap((folder) => readdirSync(new URL(`fixtures/${kind}/${folder}/`, CONTRACTS)).map((file) => `${folder}/${file}`))
    .sort();
