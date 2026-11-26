# server/domain/sheet/formula

Računalo formula za tablični dokument (val 14, SRV-V14-SHEET-FORMULAS, odluka 3). Samo čiste funkcije bez I/O-a, bez sata, slučajnosti i mreže; uvozi samo model kroz `../index.ts` (tip i A1 reference iz `../model/schema.ts`). Rezultat formule nikad nije pohranjen kao istina (odluka 4): server ga uvijek ponovno računa iz teksta formule. Nema rute ni ugovora; izvoz CSV/.xlsx i predaja koriste `computeSheet` u svojim zadacima.

## Jezik formula

Formula počinje s `=`, najviše 500 točaka koda. Razmaci i tabulatori između znakova se preskaču.

- Operatori po prednosti: unarni `+ -`; `* /`; `+ -`; usporedbe `= <> < <= > >=` (lijevo asocijativno). Nema `^`, `&`, postotka ni eksponenta u broju.
- Brojevi: `12`, `1.5`, `.5` (točka je uvijek decimalni znak). Tekst: `"..."`, `""` je jedan navodnik.
- Reference A1 (stupci A–Z, retci 1–200) i rasponi `A1:B3` (obrnuti raspon se normalizira). Nazivi funkcija i reference čitaju se u bilo kojem slovu; nema `$`, naziva lista ni naziva raspona.
- Funkcije: `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `ROUND(x, n)`, `ABS`, `IF(uvjet, a[, b])`. Nema `NOW`, `RAND`, vanjskih podataka ni makroa.

## Vrijednosti i pogreške

Greška je vrijednost, jedna od pet: `#DIV/0!`, `#REF!`, `#CIRC!`, `#NAME?`, `#VALUE!`. Rezultat je prva greška na koju izračun naiđe (lijevo prije desno, argumenti redom).

| Situacija                                                                                                                                                | Rezultat  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| dijeljenje nulom (prazna ćelija je 0), `AVERAGE` bez brojeva                                                                                             | `#DIV/0!` |
| referenca izvan mreže (`AA1`, `A0`, `A201`) ili izvan veličine lista (`rows`, `columns`)                                                                 | `#REF!`   |
| ćelija u ciklusu ili ćelija koja čita samu sebe                                                                                                          | `#CIRC!`  |
| nepoznata funkcija ili golo ime                                                                                                                          | `#NAME?`  |
| sintaksna greška, tekst koji nije broj u računu, raspon kao jedna vrijednost, kriv broj argumenata, prekoračena granica, rezultat koji nije konačan broj | `#VALUE!` |

- **Brojevi** su IEEE 754 binary64. Rezultat svake formule zaokružuje se na 15 značajnih znamenki, pola od nule (`0.1+0.2` je `0.3`); `-0` se ne pojavljuje. `ROUND(x, n)` zaokružuje na `n` decimala (`n` se skraćuje prema nuli; negativan lijevo od točke) istim pravilom, na najkraćem decimalnom zapisu koji se čita natrag u isti double (`ROUND(2.675, 2)` je `2.68`). Beskonačnost i `NaN` ne postoje: `x/0` je `#DIV/0!`, svaki drugi preljev `#VALUE!`.
- **Račun** čita broj, praznu ćeliju (0) i tekst koji je običan decimalni broj (`"12"`, `"-1.5"`; ne `"1e3"`, ne s razmacima); drugi tekst je `#VALUE!`.
- **Usporedba** daje `1` ili `0` (nema posebne logičke vrijednosti). Prazna ćelija je 0 uz broj i `""` uz tekst. Tekst se uspoređuje točku po točku koda, uz razlikovanje veličine slova, neovisno o lokalizaciji. Broj nikad nije jednak tekstu (`=` daje 0, `<>` daje 1), a `< <= > >=` između broja i teksta je `#VALUE!`.
- **IF** računa samo odabranu granu (greška u drugoj se ne vidi); uvjet je broj različit od 0, prazna ćelija je neistina, tekst je `#VALUE!`; bez trećeg argumenta neistina daje 0.
- **Zbirne funkcije**: reference i rasponi daju samo brojeve (tekst i prazne ćelije se preskaču), greška u rasponu je rezultat (osim kod `COUNT`, koji greške preskače); izravni argument mora biti broj ili tekst-broj. `SUM` i `AVERAGE` zbrajaju brojeve uzlazno sortirane, pa premještanje redaka nikad ne mijenja zbroj. `SUM`/`MIN`/`MAX` bez brojeva su 0. Bez argumenata je `#VALUE!`.

## Granice

- formula do 500 točaka koda (`MAX_FORMULA_CODE_POINTS` iz modela), ugniježđenost do 32 (`MAX_FORMULA_DEPTH`: zagrade, pozivi i predznaci), svi rasponi jedne formule zajedno do 10 000 ćelija (`MAX_FORMULA_RANGE_CELLS`). Kod koji `parseFormula` vraća (`FORMULA_PREFIX`, `FORMULA_TOO_LONG`, `FORMULA_SYNTAX`, `FORMULA_TOO_DEEP`, `FORMULA_RANGE_TOO_LARGE`) u ćeliji postaje `#VALUE!`.

## Redoslijed i ciklusi

`computeSheet` gradi graf ovisnosti iz referenci napisanih u formulama (sve grane `IF`-a, svaka ćelija raspona) i računa ćelije ovisnostima prvo (Tarjanove komponente, bez rekurzije). Svaka ćelija u ciklusu je `#CIRC!`, kao i ona koja čita samu sebe ili raspon koji je sadrži; zato ishod ne ovisi o tome koja se ćelija računa prva. Ćelija koja čita ćeliju u ciklusu dobiva istu grešku preko pravila o prvoj grešci.

## Vektori

`formula-vectors.json`: ručno izvedeni ulazi i očekivane vrijednosti, nikad izvedeni iz koda; isti bajt-za-bajt kopira WEB-V14-SHEET-FORMULAS (test pariteta). Test je `formula.test.ts`, svojstveni testovi `formula.property.test.ts`.
