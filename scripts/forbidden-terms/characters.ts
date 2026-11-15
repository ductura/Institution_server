/**
 * Characters that interface text may not hold, ported word for word from Ductus
 * scripts/forbidden-terms/terms.ts at d52a92c3 (`unreadableCharacters`,
 * `shownText`; S-1L.1, DAN-768, PR-b2, contract Ductus#1836 c.6890523605). Kept
 * apart from `./terms.ts` so that file stays the dictionary. The one change:
 * Ductus's guard also names `closedUpPastQuotes` of its markup reading, which
 * was not ported (no markup in locales/).
 */
import { INVISIBLE, foldLetters } from "./terms.ts";

/**
 * White space that may stand between two letters of one text without being
 * reported. The narrow no-break space (U+202F) is left out on purpose: it is
 * thin enough to cut a word without showing, and where typography wants it,
 * between a number and its unit, it does not stand between two letters.
 */
const PLAIN_SPACE = /[  ]/u;
/** A run of anything but letters and digits that touches a letter on both sides. */
const BETWEEN_LETTERS = /(?<=\p{L})[^\p{L}\p{N}]+(?=\p{L})/gu;
/** A symbol, a space or a punctuation mark, of any kind. */
const SYMBOL_SPACE_OR_MARK = /[\p{S}\p{Zs}\p{P}]/u;
/**
 * The punctuation marks outside ASCII that Croatian and English write between
 * two letters with no space: the hyphen and the non-breaking hyphen (U+2010,
 * U+2011), the en dash and the em dash (U+2013, U+2014), the apostrophe
 * (U+2019) and the ellipsis (U+2026). None of them is drawn like a letter.
 * Every other mark outside ASCII is reported there, because some are (an
 * upright bar, a dot at the height of a letter) and nobody can tell them
 * apart in a review. That holds for quotation marks and brackets too, and
 * ASCII punctuation next to them does not change it: only a plain space sets
 * two words apart.
 */
const MARKS_INSIDE_A_WORD: ReadonlySet<number> = new Set([
  0x2010, 0x2011, 0x2013, 0x2014, 0x2019, 0x2026,
]);
/** A mathematical, currency or modifier symbol that touches a letter. */
const SYMBOL_AT_A_LETTER = /(?<=\p{L})[\p{Sm}\p{Sc}\p{Sk}]|[\p{Sm}\p{Sc}\p{Sk}](?=\p{L})/gu;
/**
 * Private use, unassigned and surrogate code points, and control characters.
 * The five controls that are white space (tab, line feed, vertical tab, form
 * feed, carriage return) are text: code that reads white space names them.
 */
const NEVER_TEXT = /[\p{Co}\p{Cn}\p{Cs}]|(?![\t\n\v\f\r])\p{Cc}/gu;
/**
 * The line separator and the paragraph separator (U+2028, U+2029). The
 * dictionary reads them as a space, and a page may show nothing for them.
 */
const SEPARATOR = /[\p{Zl}\p{Zp}]/gu;
/**
 * Format characters, but for the four that are left to the dictionary
 * (the soft hyphen and the three of zero width). The dictionary
 * drops every one of them before it matches, which is right for a character
 * that shows nothing and changes nothing. It is wrong for one that changes
 * the order in which the letters are shown (the marks, embeddings, overrides
 * and isolates of text direction: U+061C, U+200E, U+200F, U+202A to U+202E,
 * U+2066 to U+2069) and for one that is drawn (the number signs of other
 * scripts). The rest (invisible operators, annotation and shaping controls,
 * tags, a byte order mark) has no place in Croatian or English text, so the
 * whole category is reported and no list of it is kept that could go stale.
 */
const FORMAT = /(?![­​‌‍])\p{Cf}/gu;
/** Every character that `unreadableCharacters` reports wherever it stands. */
const NOT_SHOWN = new RegExp(`${NEVER_TEXT.source}|${SEPARATOR.source}|${FORMAT.source}`, "gu");

/**
 * `text` as a finding or an error may show it: every character that the guard
 * reports wherever it stands is written by its escape, `\uXXXX` or
 * `\u{XXXXX}`. Such a character shows as nothing in a log, breaks its line or
 * turns the text around it, and the mark of a boundary (`PHRASE_BREAK`) is one
 * of them. White space, letters and everything a reader can see stay as they
 * are, so the text can still be found in the source.
 */
export function shownText(text: string): string {
  return text.replace(NOT_SHOWN, (char) => {
    const code = char.codePointAt(0)!;
    const hex = code.toString(16).toUpperCase();
    return code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });
}

/** A character typed on a keyboard; what it looks like is for the reader of the source to judge. */
const isAscii = (char: string): boolean => char.codePointAt(0)! < 0x80;

/**
 * Characters that interface text may not hold, each once, as `U+XXXX`. The
 * dictionary is matched on letters, so a character that only looks
 * like a letter, or like nothing at all, would take a word past it. Such a
 * character is reported for what it is, whatever word it stands in:
 *
 * - a letter that does not fold to `a`-`z` (`foldLetters`): Cyrillic, Greek,
 *   a dotless i, an IPA letter. Croatian letters and other Latin letters with
 *   a diacritic fold, and so do the compatibility forms NFKC knows;
 * - a digit or number that does not fold to ASCII digits and Latin letters:
 *   the digits of other scripts, some of which are drawn like a Latin letter;
 * - a private use, unassigned or surrogate code point and a control character
 *   that is not white space, wherever it stands;
 * - a line or paragraph separator (`SEPARATOR`) and a format character
 *   (`FORMAT`), wherever it stands. Four format characters are left to the
 *   dictionary, which reads a word past them: the soft hyphen, the zero
 *   width space, the zero width non-joiner and the zero width joiner (U+00AD,
 *   U+200B, U+200C, U+200D). They show nothing inside a word and change
 *   nothing around it;
 * - between two letters with no `PLAIN_SPACE` between them: every symbol,
 *   every space and every punctuation mark that is not ASCII, except the
 *   marks on `MARKS_INSIDE_A_WORD`. That is a symbol with no ink (a Braille
 *   blank), a space of another width, a symbol or a mark drawn like a letter
 *   (a mathematical operator, a currency sign, an upright bar) and also an
 *   emoji, which is reported on purpose: two words with only a symbol
 *   between them are set apart with a space;
 * - a mathematical, currency or modifier symbol that is not ASCII and touches
 *   a letter on either side, since it can stand for the first or the last
 *   letter of a word. Other symbols at the edge of a word (a degree sign, a
 *   trade mark) are left alone, because that is where they are written.
 *
 * ASCII symbols and digits are not reported whatever they resemble.
 */
export function unreadableCharacters(text: string): string[] {
  const found: string[] = [
    ...(text.match(NEVER_TEXT) ?? []),
    ...(text.match(SEPARATOR) ?? []),
    ...(text.match(FORMAT) ?? []),
  ];
  for (const char of text) {
    const folded = foldLetters(char);
    if (
      /\p{L}/u.test(char)
        ? !/^[a-z]*$/.test(folded)
        : /\p{N}/u.test(char) && /[^a-z0-9]/.test(folded.replace(/[^\p{L}\p{N}]/gu, ""))
    )
      found.push(char);
  }
  // Without what the dictionary matching drops anyway, so that such a character next to the run does not hide it.
  const bare = text.replace(INVISIBLE, "").replace(/\p{M}/gu, "");
  for (const run of bare.match(BETWEEN_LETTERS) ?? []) {
    if (PLAIN_SPACE.test(run)) continue;
    found.push(
      ...[...run].filter(
        (char) =>
          SYMBOL_SPACE_OR_MARK.test(char) &&
          !isAscii(char) &&
          !MARKS_INSIDE_A_WORD.has(char.codePointAt(0)!),
      ),
    );
  }
  found.push(...(bare.match(SYMBOL_AT_A_LETTER) ?? []).filter((char) => !isAscii(char)));
  const codes = found.map(
    (char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
  );
  return [...new Set(codes)];
}
