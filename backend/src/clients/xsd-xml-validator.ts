import { readFileSync } from "node:fs";
import { validateXML } from "xmllint-wasm";
import type { ValidationResult } from "../domain/validation-result";
import { WHOLE_DOCUMENT, toFindings } from "./xsd-findings";
import type { XmlValidator } from "./xml-validator";

// XSD validation with libxml2 compiled to WebAssembly (the npm package `xmllint-wasm`). It
// is the same libxml2 that the Python recipient uses through lxml, so the two sides read the
// schemas the same way, and no native binary has to be built for Lambda.
//
// How it works, and what to know about it:
//   - Every validateXML() call starts a worker thread with a fresh copy of the WebAssembly
//     module, validates, and stops the thread. That is about 70 ms per call on a laptop,
//     and it means that concurrent calls are independent of each other.
//   - The package finds its worker script and its .wasm file next to itself on disk, so it
//     cannot be bundled by esbuild. scripts/build.mjs leaves it out of the bundle and copies
//     the package next to it (dist/delivery-worker/node_modules/xmllint-wasm).
//   - It reads no files and makes no network request on its own: the schemas are passed in
//     as text, and `schemaLocation="common-types.xsd"` inside them is resolved against the
//     `preload` files (an xs:import needs the imported file to be given this way).

// The largest document we look at, in bytes. It is the size limit of the recipient's contract
// (contracts/partner-api.md), and a Reply is meant to be tiny. The client refuses to read more
// than this from the network; the check here is the second wall, for whatever else calls us.
export const MAX_XML_BYTES = 64 * 1024;

interface XsdFile {
  fileName: string;
  contents: string;
}

export class XsdXmlValidator implements XmlValidator {
  private readonly commonTypes: XsdFile;
  private readonly submission: XsdFile;
  private readonly reply: XsdFile;

  /**
   * Reads the three schema files ONCE, when the function starts. `schemasDirectory` is a
   * URL that ends with "/": the `schemas/` folder next to the bundle in Lambda (the build
   * copies contracts/xsd/ there), and contracts/xsd/ itself in the tests.
   */
  constructor(schemasDirectory: URL) {
    const load = (fileName: string): XsdFile => ({
      fileName,
      contents: readFileSync(new URL(fileName, schemasDirectory), "utf8"),
    });
    this.commonTypes = load("common-types.xsd");
    this.submission = load("submission.xsd");
    this.reply = load("reply.xsd");
  }

  validateSubmission(xml: string): Promise<ValidationResult> {
    return this.validate(xml, this.submission);
  }

  validateReply(xml: string): Promise<ValidationResult> {
    return this.validate(xml, this.reply);
  }

  private async validate(xml: string, schema: XsdFile): Promise<ValidationResult> {
    // These checks look at the raw text and run BEFORE any parser sees it. They are the
    // defence against oversized input and against entity attacks, and they do not depend on
    // what the WebAssembly build does by default.
    const refusal = refuseBeforeParsing(xml);
    if (refusal !== undefined) {
      return { valid: false, findings: [{ element: WHOLE_DOCUMENT, rule: refusal }] };
    }

    let result;
    try {
      result = await validateXML({
        xml: [{ fileName: "document.xml", contents: xml }],
        // The main schema first, and the file it imports as `preload`.
        schema: [schema],
        preload: [this.commonTypes],
      });
    } catch (error) {
      // The validator could not run (a bug, no memory). xmllint's own message is NOT passed
      // on: it can quote the document. The exit code is a number and safe.
      const code = (error as { code?: unknown }).code;
      throw new Error(`XSD validation could not run${typeof code === "number" ? ` (exit code ${code})` : ""}`);
    }

    // A document that is not valid, and one that is not even well-formed, both come back as
    // `valid: false`; toFindings tells them apart by the shape of the messages.
    return result.valid ? { valid: true } : { valid: false, findings: toFindings(result.errors) };
  }
}

// The raw-text checks. Returns the rule that was broken, or `undefined` when the text may go
// on to the parser.
function refuseBeforeParsing(xml: string): string | undefined {
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) return "document too large";

  // Any DOCTYPE is refused, which is the policy of the recipient too (contracts/partner-api.md):
  // without a DOCTYPE a document cannot define entities, so "billion laughs" (entity
  // expansion) and external entities (XXE) have nothing to work with. A DOCTYPE can only
  // appear after `<!DOCTYPE`; `<!ENTITY` is refused on its own as well, as a second rule.
  // Case does not matter: XML is case-sensitive, so a lower-case one would not be a DOCTYPE,
  // but nothing is lost by refusing it too.
  // The trade-off: text that merely CONTAINS these words in a comment or a CDATA section is
  // refused as well. A Reply or a Submission never has a legitimate reason to contain them,
  // so a false alarm costs nothing, and the rule stays a plain text search anyone can read.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return "DOCTYPE not allowed";

  // The text search above works on the characters we hold. A document that declares another
  // encoding could make the parser read the same bytes as different characters, so the
  // search would prove nothing. Both sides speak UTF-8 (the Reply is served as
  // `charset=utf-8`), so any other declared encoding is refused.
  const declared = /^<\?xml[^>]*?\sencoding\s*=\s*["']([^"']*)["']/.exec(xml.replace(/^﻿/, ""));
  if (declared !== null && declared[1]?.toLowerCase() !== "utf-8") return "encoding must be UTF-8";

  return undefined;
}
