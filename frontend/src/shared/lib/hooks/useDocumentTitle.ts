import { useEffect } from "react";

const APP_NAME = "Partner requests";

// A single-page app never reloads, so the browser tab title (and what a screen reader
// announces) stays the same unless we change it. Each page calls this with its own name.
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
}
