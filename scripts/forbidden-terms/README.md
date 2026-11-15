# scripts/forbidden-terms

Rječnik zabranjenih izraza sučelja (Ductus [docs/PRODUCT.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/PRODUCT.md) §5), prenesen iz Ductusa `scripts/forbidden-terms/terms.ts` na `d52a92c3` (S-1L.1, DAN-768, PR-b1).

- `terms.ts`: `FORBIDDEN_TERMS` (hrvatske i engleske stavke), savijanje teksta (`foldText`, `foldPhrases`) i `findForbiddenTerms(text, lang?)`. Gdje se Ductus i doslovni §5 razlikuju, vrijedi stroža strana (ugovor Ductus#1836 c.6890523605, potvrda c.6890541239): „kopir-” samo u „Kopiraj navod”, „kopiranje navoda” i „Kopirano u međuspremnik”; „copy” samo u „Copy citation”; i prilog „vjerojatno”; retci s uvjetom provjeravaju se uvijek; „vanished data” i dodatni engleski popis D-276. U kodu je svaka razlika označena s „§5 delta N”.
- Nije preneseno: čitanje markupa (`findForbiddenTermsInMarkup` i prozori), `entities.ts` i Ductusov `scan.ts`. U `locales/` nema JSX-a ni HTML-a.
- `characters.ts` (PR-b2): `unreadableCharacters` (homoglifi, kontrole smjera teksta, znakovi koji razdvajaju riječ) i `shownText` (nalaz ili greška pišu takve znakove kao `\uXXXX`), preneseni doslovno iz istog izvora. `terms.ts` za njih izvozi `foldLetters` i `INVISIBLE`.
- `scan.ts` (PR-b2): `scanLocales(root)`, jedan validator cijelog `locales/`. Opis je u [locales/README.md](../../locales/README.md), „Skener zabranjenih izraza”.
- `index.ts`: javno sučelje mape.

Test `terms.test.ts` prenosi Ductusove slučajeve za `findForbiddenTerms` i dodaje pozitivne i negativne slučajeve za svaku razliku.

`characters.test.ts` prenosi Ductusove slučajeve za `unreadableCharacters` i `shownText`, a `scan.test.ts` skenira stvarni `locales/` i za svaku invarijantu ugovora ima negativni test na kopiji u privremenoj mapi.
