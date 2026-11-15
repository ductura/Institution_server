// Ported from Ductus tests/unit/forbidden-terms-unreadable.test.ts at d52a92c3
// (S-1L.1, DAN-768, PR-b2): the cases that call unreadableCharacters and
// shownText directly (describe "characters interface text may not hold",
// "separators and format characters" without the file scans, and the escape
// checks of "what a check hands over shows no character that a log cannot
// show"). Cases that read app/ or src/ through Ductus's scan.ts have nothing to
// test here; the locales scan has its own tests in scan.test.ts.
import { describe, expect, it } from "vitest";

import { shownText, unreadableCharacters } from "./characters.ts";
import { PHRASE_BREAK, findForbiddenTerms } from "./terms.ts";

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const code = (value: number): string => `U+${value.toString(16).toUpperCase().padStart(4, "0")}`;
const escape = (value: number): string => `\\u${value.toString(16).toUpperCase().padStart(4, "0")}`;

describe("characters interface text may not hold", () => {
  /** What it is, the text, the code points reported. */
  const CHARACTERS: readonly [string, string, readonly string[]][] = [
    ["Cyrillic je in a Latin word", `Sumn${cp(0x458)}ivo`, ["U+0458"]],
    ["Cyrillic i", `R${cp(0x456)}zik`, ["U+0456"]],
    ["Cyrillic a", `Kopir${cp(0x430)}no`, ["U+0430"]],
    ["Greek omicron", `Skriven${cp(0x3bf)}`, ["U+03BF"]],
    ["long s, drawn like f (local addition, QA of PR-b2)", `${cp(0x17f)}lagged`, ["U+017F"]],
    ["dotless i", `R${cp(0x131)}zik`, ["U+0131"]],
    ["IPA letter", `Sum${cp(0x272)}jivo`, ["U+0272"]],
    ["Cyrillic letter in a word that is no entry", `Predan${cp(0x43e)}`, ["U+043E"]],
    [
      "a word written in another script",
      cp(0x420, 0x438, 0x441, 0x43a),
      ["U+0420", "U+0438", "U+0441", "U+043A"],
    ],
    ["hair space inside a word", `Sum${cp(0x200a)}njivo`, ["U+200A"]],
    ["thin space inside a word", `Sum${cp(0x2009)}njivo`, ["U+2009"]],
    ["Braille blank inside a word", `Sum${cp(0x2800)}njivo`, ["U+2800"]],
    ["Braille blank in place of the space of a phrase", `Nestali${cp(0x2800)}podaci`, ["U+2800"]],
    ["musical null note inside a word", `Sum${cp(0x1d159)}njivo`, ["U+1D159"]],
    ["two inkless characters in a row", `Sum${cp(0x2800, 0x200a)}njivo`, ["U+2800", "U+200A"]],
    ["inkless character next to a soft hyphen", `Sum${cp(0x200a, 0xad)}njivo`, ["U+200A"]],
    ["private use code point", `Sum${cp(0xe000)}njivo`, ["U+E000"]],
    ["private use code point at the end", `Predano${cp(0xf8ff)}`, ["U+F8FF"]],
    ["unassigned code point", `Sum${cp(0x2065)}njivo`, ["U+2065"]],
    ["the same character twice", `${cp(0x430)}n${cp(0x430)}`, ["U+0430"]],
    ["thin space after a hyphen inside a word", `Sum-${cp(0x2009)}njivo`, ["U+2009"]],
    ["narrow no-break space between two letters", `Sum${cp(0x202f)}njivo`, ["U+202F"]],
    ["emoji between two letters", `Predano${cp(0x1f389)}danas`, ["U+1F389"]],
    ["mathematical symbol drawn like a letter", `S${cp(0x222a)}mnjivo`, ["U+222A"]],
    ["mathematical symbol between two letters", `Sum${cp(0x2218)}njivo`, ["U+2218"]],
    ["currency sign between two letters", `Ri${cp(0xa2)}ik`, ["U+00A2"]],
    ["modifier symbol between two letters", `Sum${cp(0xb4)}njivo`, ["U+00B4"]],
    ["arrow between two letters", `Natrag${cp(0x2192)}Dalje`, ["U+2192"]],
    ["mathematical symbol with punctuation around it", `Sum-${cp(0x2218)}-njivo`, ["U+2218"]],
    ["currency sign with punctuation around it", `Ri.${cp(0xa2)}.ik`, ["U+00A2"]],
    ["modifier symbol with punctuation around it", `Sum'${cp(0xb4)}'njivo`, ["U+00B4"]],
    ["mathematical symbol in place of the first letter", `${cp(0x222b)}umnjivo`, ["U+222B"]],
    ["mathematical symbol in place of the last letter", `Sumnjiv${cp(0x2218)}`, ["U+2218"]],
    ["currency sign in place of the first letter", `${cp(0xa2)}opied`, ["U+00A2"]],
    ["modifier symbol at the end of a word", `Rizik${cp(0x2c5)}`, ["U+02C5"]],
    ["connector mark between two letters (Pc)", `Sum${cp(0x203f)}njivo`, ["U+203F"]],
    ["full width low line between two letters (Pc)", `Sum${cp(0xff3f)}njivo`, ["U+FF3F"]],
    ["upright dash between two letters (Pd)", `Sumnj${cp(0xfe31)}vo`, ["U+FE31"]],
    ["figure dash between two letters (Pd)", `Sum${cp(0x2012)}njivo`, ["U+2012"]],
    ["opening quotation mark between two letters (Ps)", `Sum${cp(0x201e)}njivo`, ["U+201E"]],
    ["full width opening bracket (Ps)", `Sum${cp(0xff08)}njivo`, ["U+FF08"]],
    ["full width closing bracket (Pe)", `Sum${cp(0xff09)}njivo`, ["U+FF09"]],
    ["closing bracket of another kind (Pe)", `Sum${cp(0x2046)}njivo`, ["U+2046"]],
    ["opening double quotation mark (Pi)", `Sum${cp(0x201c)}njivo`, ["U+201C"]],
    ["opening angle quotation mark (Pi)", `Sum${cp(0xab)}njivo`, ["U+00AB"]],
    ["closing double quotation mark (Pf)", `Sum${cp(0x201d)}njivo`, ["U+201D"]],
    ["closing angle quotation mark (Pf)", `Sum${cp(0xbb)}njivo`, ["U+00BB"]],
    ["upright bar of another script (Po)", `Sumnj${cp(0x5c0)}vo`, ["U+05C0"]],
    ["double upright line (Po)", `Sumnj${cp(0x2016)}vo`, ["U+2016"]],
    ["inverted exclamation mark (Po)", `R${cp(0xa1)}zik`, ["U+00A1"]],
    ["dagger (Po)", `Au${cp(0x2020)}enticnost`, ["U+2020"]],
    ["middle dot (Po)", `Sum${cp(0xb7)}njivo`, ["U+00B7"]],
    ["hyphenation point (Po)", `Sum${cp(0x2027)}njivo`, ["U+2027"]],
    ["full width full stop (Po)", `Sum${cp(0xff0e)}njivo`, ["U+FF0E"]],
    ["a mark not written there, next to one that is", `Sum${cp(0x2013, 0x5c0)}njivo`, ["U+05C0"]],
    [
      "quotation mark after a line break with no space",
      `kraj.\n${cp(0x201e)}Sada${cp(0x201d)}`,
      ["U+201E"],
    ],
    ["digit of another script inside a word", `R${cp(0x661)}zik`, ["U+0661"]],
    ["digit of another script drawn like a letter", `Skriven${cp(0x7c0)}`, ["U+07C0"]],
    ["number of another script drawn like a letter", `Skriven${cp(0x3007)}`, ["U+3007"]],
    ["digit of another script by itself", cp(0x665), ["U+0665"]],
    ["control character inside a word", `Sum${cp(0x1)}njivo`, ["U+0001"]],
    ["escape character", `${cp(0x1b)}[0m`, ["U+001B"]],
    ["delete character", `Sum${cp(0x7f)}njivo`, ["U+007F"]],
    ["C1 control character", `Sum${cp(0x85)}njivo`, ["U+0085"]],
    ["surrogate without its pair", `Sum${"\uD800"}njivo`, ["U+D800"]],
    ["the mark of a phrase end written in a text", `Rok${PHRASE_BREAK}predaje`, ["U+FFFF"]],
    // Allowed: Croatian and English text as it is written.
    ["Croatian letters", "Čekanje, ćirilica, đak, šuma, žir; DŽ, Dž, LJ, NJ", []],
    ["Latin letters with other diacritics", "Café, naïve, Zürich, Ångström", []],
    ["full width letters, which the dictionary folds", "Ｐｒｅｄａｎｏ", []],
    ["ligature", "ﬁnale", []],
    ["no-break space between words", `Spremljeno na${cp(0xa0)}uređaju`, []],
    ["symbol set apart by spaces", "Predano ✓ danas", []],
    ["symbol after a word", "Ductura © 2026", []],
    ["inkless character next to a plain space", `Rok ${cp(0x2800)}predaje`, []],
    ["punctuation, digits and line breaks", "Rok: 2. 11. 2026. (14:05)\n„Predaj” – 50 %", []],
    ["emoji after a word", "Predano 🎉", []],
    ["apostrophe (Pf)", `it${cp(0x2019)}s, rock${cp(0x2019)}n${cp(0x2019)}roll`, []],
    ["hyphen and non-breaking hyphen (Pd)", `e${cp(0x2010)}indeks, e${cp(0x2011)}indeks`, []],
    ["en dash and em dash (Pd)", `Zagreb${cp(0x2013)}Split, rok${cp(0x2014)}danas`, []],
    ["ellipsis (Po)", `Pričekaj${cp(0x2026)}spremno`, []],
    [
      "ASCII marks between two letters",
      'on-line, it\'s, a.b, a_b, a/b, (a)b, a:b, a"b"c, a!b, a,b;c',
      [],
    ],
    [
      "quotation marks and brackets at the edge of a word",
      `Gumb ${cp(0x201e)}Predaj${cp(0x201d)} i ${cp(0xab)}Natrag${cp(0xbb)}, (${cp(0x201c)}Rok${cp(0x201d)}), ${cp(0x2018)}da${cp(0x2019)}`,
      [],
    ],
    [
      "marks outside ASCII at the edge of a word or between digits",
      `${cp(0xa1)}Hola!, Autor${cp(0x2020)}, 3${cp(0xb7)}4, Naslov ${cp(0xb7)} Autor, ${cp(0x2022)} Stavka`,
      [],
    ],
    [
      "narrow no-break space between a number and its unit",
      `5${cp(0x202f)}kg i 20${cp(0x202f)}%`,
      [],
    ],
    [
      "numbers that fold to ASCII digits and Latin letters",
      "m², ½ sata, ① korak, Ⅳ. poglavlje, １２",
      [],
    ],
    ["ASCII symbols between letters", "a+b, x=y, C|D, cijena$dan, a~b, a^b, a`b, a<b>c", []],
    ["degree sign and marks at the edge of a word", "20 °C, Ductura™, ©Autor, ®Znak", []],
    [
      "mathematical and currency symbols set apart or next to digits",
      "Natrag ← → Dalje, 3×4, 3 × 4, 5 €, 5€, ±2, a ≤ b",
      [],
    ],
    ["control characters that are white space", "a\tb\nc\vd\fe\rf", []],
    ["line separator, which a page may show as nothing", `Rok${cp(0x2028)}predaje`, ["U+2028"]],
    // What the dictionary matching already takes out of a word.
    [
      "soft hyphen, zero width space and joiner",
      `Pre${cp(0xad)}da${cp(0x200b)}n${cp(0x200d)}o`,
      [],
    ],
    ["combining mark and variation selector", `Pre${cp(0x34f)}da${cp(0xfe0f)}no`, []],
    ["Hangul filler", `Pre${cp(0x115f)}dano`, []],
  ];

  it.each(CHARACTERS)("%s", (_, text, expected) => {
    expect(unreadableCharacters(text)).toEqual(expected);
  });

  // Every code point, so that no category is left to chance; the allowed ones are written out a second time on purpose.
  it("reports every punctuation mark, symbol and space outside ASCII between two letters, but for a short list", () => {
    const written = [0xa0, 0x2010, 0x2011, 0x2013, 0x2014, 0x2019, 0x2026];
    const passed: number[] = [];
    let seen = 0;
    for (let value = 0x80; value <= 0x10ffff; value += 1) {
      if (value >= 0xd800 && value <= 0xdfff) continue;
      const char = cp(value);
      if (!/[\p{P}\p{S}\p{Zs}]/u.test(char)) continue;
      seen += 1;
      const found = unreadableCharacters(`Sum${char}njivo`);
      if (found.length === 0) passed.push(value);
      else expect(found).toEqual([code(value)]);
    }
    expect(seen).toBeGreaterThan(8000);
    expect(passed).toEqual(written);
  });

  it("leaves what the dictionary already takes out of a word to the dictionary", () => {
    for (const inside of [0xad, 0x200b, 0x34f, 0xfe0f, 0xe0041, 0x115f, 0x180e, 0x17b5]) {
      expect(findForbiddenTerms(`Sum${cp(inside)}njivo`).map((term) => term.entry)).toEqual([
        "sumnjivo",
      ]);
    }
  });
});

describe("separators and format characters", () => {
  /** What it is, the code point. */
  const NAMED: readonly [string, number][] = [
    ["line separator (Zl)", 0x2028],
    ["paragraph separator (Zp)", 0x2029],
    ["Arabic letter mark", 0x61c],
    ["left-to-right mark", 0x200e],
    ["right-to-left mark", 0x200f],
    ["left-to-right embedding", 0x202a],
    ["right-to-left embedding", 0x202b],
    ["pop directional formatting", 0x202c],
    ["left-to-right override", 0x202d],
    ["right-to-left override", 0x202e],
    ["left-to-right isolate", 0x2066],
    ["right-to-left isolate", 0x2067],
    ["first strong isolate", 0x2068],
    ["pop directional isolate", 0x2069],
    ["word joiner", 0x2060],
    ["invisible times", 0x2062],
    ["a deprecated format character", 0x206a],
    ["byte order mark", 0xfeff],
    ["interlinear annotation anchor", 0xfff9],
    ["Arabic number sign, which is drawn", 0x600],
    ["Mongolian vowel separator", 0x180e],
  ];

  it.each(NAMED)("reports a %s wherever it stands", (_, value) => {
    const char = cp(value);
    for (const text of [
      `Sum${char}njivo`,
      `${char}Rok`,
      `Rok${char}`,
      `Rok ${char} predaje`,
      `2${char}3`,
      char,
    ]) {
      expect(unreadableCharacters(text), JSON.stringify(text)).toEqual([code(value)]);
    }
    expect(unreadableCharacters(`Rok${char}${char}predaje`)).toEqual([code(value)]);
  });

  it("reports the controls that show the letters of an entry in another order", () => {
    for (const [open, close] of [
      [0x202e, 0x202c],
      [0x2067, 0x2069],
      [0x202b, 0x202c],
    ] as const) {
      expect(unreadableCharacters(`${cp(open)}ovijnmuS${cp(close)}`)).toEqual([
        code(open),
        code(close),
      ]);
    }
  });

  // Every code point, so that the category is not left to a list: the four that the dictionary reads a word past.
  it("reports every separator of lines and every format character, but for four", () => {
    const written = [0xad, 0x200b, 0x200c, 0x200d];
    const passed: number[] = [];
    let seen = 0;
    for (let value = 0x80; value <= 0x10ffff; value += 1) {
      const char = cp(value);
      if (!/[\p{Cf}\p{Zl}\p{Zp}]/u.test(char)) continue;
      seen += 1;
      const found = [`Sum${char}njivo`, `${char}Rok`, `Rok ${char} predaje`].map((text) =>
        unreadableCharacters(text),
      );
      if (found.every((codes) => codes.length === 0)) passed.push(value);
      else expect(found, code(value)).toEqual([[code(value)], [code(value)], [code(value)]]);
    }
    expect(seen).toBeGreaterThan(160);
    expect(passed).toEqual(written);
    for (const value of written) {
      expect(findForbiddenTerms(`Sum${cp(value)}njivo`).map((term) => term.entry)).toEqual([
        "sumnjivo",
      ]);
    }
  });
});

describe("shownText", () => {
  const HIDDEN = new RegExp(
    `[\\p{Co}\\p{Cn}\\p{Cs}\\p{Zl}\\p{Zp}]|(?![\\t\\n\\v\\f\\r])\\p{Cc}|(?![${cp(0xad, 0x200b, 0x200c, 0x200d)}])\\p{Cf}`,
    "u",
  );

  // One plane per case: the whole range in one case can pass the 5 s limit on a slower machine.
  it.each(Array.from({ length: 17 }, (_, plane) => plane))(
    "writes by its escape every character of plane %i that the guard reports wherever it stands, and no other",
    (plane) => {
      const wrong: string[] = [];
      for (let value = plane * 0x10000; value <= plane * 0x10000 + 0xffff; value += 1) {
        const char = cp(value);
        const hidden = HIDDEN.test(char);
        const expected = !hidden
          ? char
          : value > 0xffff
            ? `\\u{${value.toString(16).toUpperCase()}}`
            : escape(value);
        if (shownText(char) !== expected) wrong.push(value.toString(16));
        if (
          !/[\p{Co}\p{Cn}\p{L}\p{N}]/u.test(char) &&
          unreadableCharacters(`Rok ${char} predaje`).length > 0 !== hidden
        ) {
          wrong.push(`guard ${value.toString(16)}`);
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  it("leaves what a reader can see as it is, and is shown once when shown twice", () => {
    for (const value of [0x378, 0xe000, 0xf8ff, 0xffff, 0xf0000, 0x10ffff]) {
      expect(unreadableCharacters(cp(value))).toHaveLength(1);
    }
    const plain = `Čekanje „šuma” – 50 %\t\n\r 🎉 ${cp(0xa0, 0xad, 0x200b, 0x200c, 0x200d, 0x2009, 0x430)}`;
    expect(shownText(plain)).toBe(plain);
    expect(shownText(`a${cp(0xffff)}b${cp(0xe0001)}c${cp(0x10ffff)}`)).toBe(
      "a\\uFFFFb\\u{E0001}c\\u{10FFFF}",
    );
    expect(shownText(shownText(`a${cp(0x202e)}b`))).toBe("a\\u202Eb");
  });
});
