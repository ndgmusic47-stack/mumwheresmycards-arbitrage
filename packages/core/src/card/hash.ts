import type { CardPrinting } from "./types.js";

/**
 * Deterministic identity hash for a CardPrinting. Uses every field that
 * distinguishes one exact printing from another. Field order is fixed so
 * the same printing always hashes identically across runs/processes.
 *
 * Intentionally a plain FNV-1a hash (fast, dependency-free, stable across
 * JS runtimes including Workers) rather than a crypto hash — this is an
 * identity key, not a security boundary.
 */
export function hashPrinting(p: Omit<CardPrinting, "printingHash">): string {
  const key = [
    p.game,
    normalize(p.name),
    normalize(p.setName),
    normalize(p.setCode),
    normalize(p.cardNumber),
    String(p.year),
    p.language,
    p.edition,
    p.variant,
    p.finish,
    normalize(p.stampType ?? ""),
  ].join("|");

  return fnv1a(key);
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Unsigned 32-bit hex, zero-padded, prefixed for readability/debuggability.
  return "pc_" + (hash >>> 0).toString(16).padStart(8, "0");
}
