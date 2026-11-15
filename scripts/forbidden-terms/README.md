# scripts/forbidden-terms

Rječnik zabranjenih izraza sučelja (Ductus [docs/PRODUCT.md](https://github.com/danielrisavi77-create/Ductus/blob/main/docs/PRODUCT.md) §5), prenesen iz Ductusa `scripts/forbidden-terms/terms.ts` na `d52a92c3` (S-1L.1, DAN-768, PR-b1).

- `terms.ts`: `FORBIDDEN_TERMS` (hrvatske i engleske stavke), savijanje teksta (`foldText`, `foldPhrases`) i `findForbiddenTerms(text, lang?)`. Gdje se Ductus i doslovni §5 razlikuju, vrijedi stroža strana (ugovor Ductus#1836 c.6890523605, potvrda c.6890541239): „kopir-” samo u „Kopiraj navod”, „kopiranje navoda” i „Kopirano u međuspremnik”; „copy” samo u „Copy citation”; i prilog „vjerojatno”; retci s uvjetom provjeravaju se uvijek; „vanished data” i dodatni engleski popis D-276. U kodu je svaka razlika označena s „§5 delta N”.
- Nije preneseno: čitanje markupa (`findForbiddenTermsInMarkup` i prozori), `entities.ts` i Ductusov `scan.ts`. U `locales/` nema JSX-a ni HTML-a.
- Slijedi PR-b2: provjera znakova (`unreadableCharacters`) i skener koji čita svaki tekst u `locales/**`.
- `index.ts`: javno sučelje mape.

Test `terms.test.ts` prenosi Ductusove slučajeve za `findForbiddenTerms` i dodaje pozitivne i negativne slučajeve za svaku razliku.
