# server/collaboration/suggestions

Prijedlozi izmjene teksta (SRV-8F, Ductus `docs/backend/suradnja.md` §4.15, D-34, C-9). Mapa je dio kopirane mape `server/collaboration` ([Karta servera](../../../docs/server-map.md), „Kopirane mape izvan karte”).

## Što radi

Prijedlog je zaseban zapis sa sidrom (D-266 t. 1, Ductus `docs/ARCHITECTURE.md` §5a), nikad oznaka u shemi editora ni promjena dokumenta. Tekst rada mijenja se tek kad ga student vlasnik prihvati: `applySuggestion` iz trenutačnog stanja uživo i spremljenog prijedloga daje novi dokument, točne JCS bajtove za studentov `live.document.put` i zabilježenu promjenu s izvorom „izmjena nastavnika” (`teacher-suggestion`). Dokument koji primi ne mijenja, pa prijedlog sam ne mijenja ni rad ni njegov hash. `attributeChange` pripisuje promjenu prijedlogu samo ako je točno rezultat spremljenog prijedloga; sve drugo je studentova promjena. `nextState` je tablica prijelaza (čeka, prihvaćen, odbijen).

## Tko ga zove

Zasad samo testovi. Spremanje prijedloga (tablica `collaboration.suggestion`, RLS, RPC-ovi i pgTAP) i HTTP ruta dolaze u sljedećim koracima.

## Koje podatke dira

Nijedne: čiste funkcije bez I/O-a. Mentorov unos ne ulazi u hash lanac rada ni u shemu `evidence`.

## Što izvozi

`applySuggestion`, `attributeChange`, `isSuggestionInput`, `isSuggestionText`, `nextState`, `SUGGESTION_STATES`, `SUGGESTION_TEXT_MAX` i tipove iz `index.ts`.

## Što ne smije uvoziti

`http`, `database` (osim `import type`) i `external/*`; uvozi samo `domain`.
