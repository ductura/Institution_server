# @ductura/test-fakes/hostile-inputs

Zajednička tablica neprijateljskih ulaza (DAN-947). Validator, parser ili čuvar prolazi cijelu tablicu umjesto vlastitog kratkog popisa, pa svaki odbija iste razrede ulaza. Prvi korisnik je `loadInstitutions` ([server/settings](../../../server/settings/institutions.test.ts)).

## Što izvozi

- `hostileStrings(valid)`: svaki razred oko ispravne vrijednosti, da se uhvati i validator koji reže ili normalizira: YAML escape (`\n` doslovno), `: `, `- `, `#`, ključ u dvostrukim i jednostrukim navodnicima, neparni visoki i niski UTF-16 surogat, CRLF, sam CR, LF, tab, NBSP (U+00A0), DEL (U+007F), razmak sprijeda, završni `/`, Windows putanja, prazan niz, samo razmak te imena `__proto__`, `toString` i `constructor`.
- `HOSTILE_STRINGS`: ista tablica oko `a`.
- `HOSTILE_KEYS`: `__proto__`, `toString`, `constructor`, `valueOf`, `hasOwnProperty`.
- `HOSTILE_JSON`: tekstovi `null`, `[]` i `[null]`; potrošač ih sam parsira.
- `hostileObjects(valid)`: svježe inačice ispravnog objekta: svaki ključ iz `HOSTILE_KEYS` kao višak vlastitog ključa (`__proto__` kao ključ, ne kao prototip), prvi ključ samo naslijeđen, prvi ključ kao getter i Proxy koji uz prave ključeve prijavljuje i `toString`. Uz svaku su `refusal` (`fields` ili `accessor`, što strogi čitač točnih vlastitih ključeva mora javiti) i `touched()`, broj poziva gettera i zamki `get` i `has`.

## Pravila

- Sve je zamrznuto, a `hostileObjects` ne mijenja ulaz.
- U izvoru su samo escape nizovi, nikad sirovi NBSP, DEL ili surogat.
- Naslov testa imenuje slučaj (`$name`), nikad sam objekt: oblikovanje gettera ili Proxyja bi ga dotaknulo.
- Zamka `ownKeys` se ne broji: `Reflect.ownKeys` je mora pozvati.
