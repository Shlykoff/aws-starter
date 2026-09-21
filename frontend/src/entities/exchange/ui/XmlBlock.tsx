// Shows an XML document exactly as it was recorded. The string is untrusted text (our own
// request text, or the answer of a third party), so it is only ever rendered as a React
// text node inside <pre><code>: React escapes it, and a `<script>` in it stays literal
// characters. Never put it into dangerouslySetInnerHTML, an href or a src.
export function XmlBlock({ label, xml }: { label: string; xml: string }) {
  return (
    // The box scrolls in both directions (long lines, long documents) and takes focus, so a
    // keyboard user can scroll it too. `min-w-0` on the parents keeps the page itself from
    // growing sideways; only this box does.
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="max-h-96 overflow-auto rounded-md border bg-muted/50 p-3 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <pre className="text-xs leading-relaxed">
        <code>{xml}</code>
      </pre>
    </div>
  );
}
