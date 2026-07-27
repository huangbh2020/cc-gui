/**
 * cn() — Tailwind class merging utility.
 *
 * Combines clsx (conditional class joining) with tailwind-merge
 * (conflict resolution). Always use this instead of raw template
 * literal className concatenation.
 *
 * @example
 *   cn("px-2 py-1", isActive && "bg-accent", "px-4") // → "py-1 bg-accent px-4"
 */
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
