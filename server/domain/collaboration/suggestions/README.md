# server/domain/collaboration/suggestions

Prijedlozi izmjene teksta (SRV-8F, Ductus `docs/backend/suradnja.md` §4.15, D-34, C-9). Mapa je preseljena iz kopirane mape `server/collaboration` u domenu (SRV-ED42-PRIJEDLOZI, odluka orkestratora Ductus#2058 c.7182249174), da je poslužitelj može koristiti kroz postojeći put domene.

## Što radi

Prijedlog je zaseban zapis sa sidrom (D-266 t. 1, Ductus `docs/ARCHITECTURE.md` §5a), nikad oznaka u shemi editora ni promjena dokumenta. Tekst rada mijenja se tek kad ga student vlasnik prihvati: `applySuggestion` iz trenutačnog stanja uživo i spremljenog prijedloga daje novi dokument, točne JCS bajtove za studentov `live.document.put` i zabilježenu promjenu s izvorom „izmjena nastavnika” (`teacher-suggestion`). Dokument koji primi ne mijenja, pa prijedlog sam ne mijenja ni rad ni njegov hash. `attributeChange` pripisuje promjenu prijedlogu samo ako je točno rezultat spremljenog prijedloga; sve drugo je studentova promjena. `nextState` je tablica prijelaza (čeka, prihvaćen, odbijen).

## Tko ga zove

Priključak baze `server/database/suggestions` pri prihvaćanju (`applySuggestion` kroz `server/domain/index.ts`); spremanje je tablica `collaboration.suggestion` (migracija `20261220190000`), rute su u `server/http/suggestions`.

## Koje podatke dira

Nijedne: čiste funkcije bez I/O-a. Mentorov unos ne ulazi u hash lanac rada ni u shemu `evidence`.

## Što izvozi

`applySuggestion`, `attributeChange`, `isSuggestionInput`, `isSuggestionText`, `nextState`, `SUGGESTION_STATES`, `SUGGESTION_TEXT_MAX` i tipove iz `index.ts`.

## Što ne smije uvoziti

Ništa izvan područja `domain` (pravilo područja, [Karta servera](../../../../docs/server-map.md) §2).
