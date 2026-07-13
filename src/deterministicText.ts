/**
 * Locale-independent ordering for persisted, hashed, signed, or otherwise
 * reproducibility-sensitive text. JavaScript relational string comparison is
 * defined over UTF-16 code units and does not consult ICU or the host locale.
 */
export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Fold protocol identifiers and policy markers without consulting ICU. */
export function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20));
}

/** Fold environment names and error codes without consulting ICU. */
export function asciiUppercase(value: string): string {
  return value.replace(/[a-z]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 0x20));
}

/**
 * Deterministic Unicode case mapping for filesystem paths. Unlike the locale
 * variants, this cannot change with the machine's configured locale.
 */
export function lowercaseInvariant(value: string): string {
  return value.toLowerCase();
}
