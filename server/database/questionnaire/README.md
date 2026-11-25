# Upitnici

`createQuestionnaireStore` je adapter upitnika kolegija (SRV-V18-UPITNIK-BAZA). Svaki poziv je jedna `withActor` transakcija s `app.*` funkcijama migracije `20261219370000_questionnaire.sql`; klijent nikad ne piše izravno u tablice. Tko što smije odlučuju funkcije iz odnosa (nastavnik kolegija, upisani student), nikad iz uloge same. Tuđe, nepoznato, neispravno i, za studenta, neotvoreno je isti ZD404.

- **Nastavnik:** izrada, uređivanje (samo nacrt), otvaranje i zatvaranje, popis, čitanje, ručni unos lista, izvoz.
- **Student:** popis otvorenih upitnika, obrazac, jedno ispunjavanje (drugi put ZD409 `already_answered`).
- **Bez osobe na listu:** list i odgovori nemaju stupac s osobom ni vrijeme, a sudjelovanje nema vezu na list. Adapter čita listove samo kao grupe po slučajnom identifikatoru; izvoz ih slaže domena (`server/domain/questionnaire`) po sažetku identifikatora.

Rute dolaze sa SRV-V18-UPITNIK-AUTOR, -ISPUNJAVANJE i -IZVOZ. Testovi: `questionnaire.test.ts` (nad lažnim `withActor`), pgTAP `db/main/tests/247-questionnaire.sql`.
