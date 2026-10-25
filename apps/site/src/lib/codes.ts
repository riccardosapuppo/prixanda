// A prepaid pass's code as a person types it, put in the form the engine
// keeps it in: upper case, three groups of four joined by dashes, from an
// alphabet without the letters and digits that read alike (no 0, 1, I or O).
// The site checks the shape before sending, so a typing slip is said at once;
// whether the code exists and works is the engine's to say.

const ALPHABET = /^[2-9A-HJ-NP-Z]{12}$/;

/** The code in its kept form, or null when what was typed cannot be one. */
export function normalCode(typed: string): string | null {
  const letters = typed.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!ALPHABET.test(letters)) return null;
  return `${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}`;
}
