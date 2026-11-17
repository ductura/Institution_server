# server/domain/assignment

Jezik rada, iz Ductusa `src/domain/assignment/work-language.ts` na `4651a25` (DAN-386; prijenos DAN-909, S-M-3), bez promjene logike, s testovima. Izmjene su samo uvozi s `.ts`.

- `WORK_LANGUAGES`: zatvoreni skup jezika rada (`hr`, `en`), isti kao CHECK `institution.is_work_language` u bazi; proširenje je nova migracija.
- `parseWorkLanguage(value)`: vraća jezik rada točno kako je zapisan ili `null` za sve ostalo, bez skraćivanja razmaka, promjene velikih slova i zadane vrijednosti.

Jezik rada odvojen je od jezika sučelja (F-06, D-67, D-70) i ne čita ga. Ductusovo treće svojstvo (neovisnost o jeziku sučelja) uvozi jezike sučelja, što `domain` ne smije; pokriva ga drugo svojstvo, jer parser čita samo ulaz.

Da vektori jezika rada iz ugovora (`server/contracts/vectors/institution.*work-language.post.json`) prolaze kroz ovu domenu, provjerava unakrsni test `tests/contracts/work-language-domain.test.ts`.

Ne uvozi ništa.
