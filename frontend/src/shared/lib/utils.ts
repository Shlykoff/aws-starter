import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// `cn` builds a class string from conditional parts (clsx) and lets a later Tailwind class
// win over an earlier conflicting one, e.g. `cn("px-2", "px-4")` gives "px-4"
// (tailwind-merge). Every shadcn component uses it to accept a `className` override.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
