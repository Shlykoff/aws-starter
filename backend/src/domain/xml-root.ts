import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";

// The one place where the text of an already validated XML document is turned into a tree, for
// reading values out of it (event-facts.ts, reply-facts.ts). libxml2 has judged the document
// valid before this runs; this only reads it.
//
// Two settings, and the reason for each:
//   - onError: stop at an error and stay silent for a warning. By default xmldom prints its
//     messages with a piece of the document to the console, and the document holds text that
//     must never be logged.
//   - normalizeLineEndings: xmldom applies the line-end rules of XML 1.1 by default, which turn
//     U+0085 and U+2028 into a line feed as well. Our schemas are XML 1.0, where only CR LF and
//     a lone CR become a line feed. Without this, a reason containing U+2028 would be stored
//     changed.

/** The root element of the document. Throws when xmldom refuses the text (callers catch it and
 *  must not keep the error: its text may quote the document). */
export function parseXmlRoot(xml: string): Element | null {
  const parser = new DOMParser({
    onError: onErrorStopParsing,
    normalizeLineEndings: (text: string) => text.replace(/\r\n?/g, "\n"),
  });
  return parser.parseFromString(xml, "application/xml").documentElement;
}
