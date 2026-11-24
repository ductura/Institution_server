# Šifrirana poruka sebi v1: kako student dolazi do ključa na drugom uređaju

**Status: ODLUČENO** (Daniel, 24. 11. 2026., odgovor u chatu orkestratora na PITANJE c.7119843989: „1. B2 2. Da 3B”; zapis orkestratora Ductus#2055 c.7120208960 i ductura/Institution_server#676 c.7120209253). Izgrađeno zadatkom SRV-NF6-SIFRA (`poruka-sebi-sifrirana-b2`, `Risk: critical`), API 1.110.0, i doradama SRV-NF6-SIFRA-2 (`pecacena-poruka-dorade`, neovisni pregled SRV #676), API 1.111.0; odjeljak 6 navodi kod. Polazište je odluka vlasnika od 24. 11. 2026. („2. Treba šifrirati da”): tekst „Poruke sebi” šifrira se na studentovu uređaju, a poslužitelj i baza čuvaju samo šifrirani tekst. Ne čita ga operater, ni netko s izravnim pristupom bazi, ni netko s kopijom (backup). Poruka mora biti dostupna i na drugom računalu. „Dokle sam stao” (položaj čitanja) ostaje nešifriran.

Dokument je nastao kao prijedlog s tri varijante (§3); vlasnik je izabrao B2, pa §4 opisuje ugovor kako je izgrađen, a §3 ostaje kao obrazloženje izbora. Mijenja `docs/contracts/mentorship-follow-v1.md` §1 kako je opisano u §4.4.

## 1. Što šifriranje štiti, a što ne

Štiti od:

- čitanja baze (SQL pristup, operater baze, DBA kod dobavljača);
- kopija baze (PITR, dnevni `pg_dump`, replike) i izvoza;
- zapisa poslužitelja (logovi, praćenje grešaka): u njima ionako nema tijela zahtjeva, a sada ni tijelo ne nosi čitljiv tekst.

Ne štiti od:

- **operatera koji promijeni kod koji poslužitelj šalje pregledniku.** Web aplikacija dobiva JavaScript od istog poslužitelja; izmijenjeni kod mogao bi uzeti tekst prije šifriranja ili ključ nakon otključavanja. To vrijedi za svaku varijantu niže i za svako šifriranje u web aplikaciji. Ublažavanje (objavljeni hash izdanja, SRI, provjerljiva gradnja) je zaseban posao, nije dio ovog prijedloga;
- zlonamjernog koda na studentovu računalu;
- metapodataka: poslužitelj i dalje vidi da poruka postoji, uz koji je rad, kad je mijenjana i položaj čitanja.

Iz toga slijedi pravilo za sve varijante: **ključ i tekst poruke nikad ne idu na poslužitelj u čitljivom obliku**, a ono što ide (omotani ključ, sol, parametri) ne smije biti dovoljno za čitanje bez tajne koju zna samo student.

## 2. Zajedničko svim varijantama

- **Ključ poruka (DEK):** 256-bitni AES-GCM ključ, jedan po studentu u ustanovi, nastaje na uređaju (`crypto.getRandomValues` / `crypto.subtle.generateKey`). Svi algoritmi su iz WebCrypto API-ja preglednika; nova kriptografska ovisnost nije potrebna, osim u varijanti A ako se izabere Argon2id (§3).
- **Na uređaju:** otključan ključ drži se kao neizvoziv `CryptoKey` u IndexedDB-u. **Odjava ga briše** zajedno s ostalim lokalnim podacima (postojeće pravilo o brisanju lokalne pohrane pri odjavi, D-122 i pravila odjave). Posljedica: nakon svake odjave i na svakom novom računalu student ponovno otključava ključ. Na zajedničkim računalima fakulteta to je jedino sigurno ponašanje.
- **Šifriranje poruke:** AES-256-GCM, novi slučajni IV od 12 bajtova za svako spremanje. Dodatni podaci (AAD) vežu šifrat uz rad i verziju: `UTF-8("ductura-self-note-v1") ‖ 0x0A ‖ UTF-8(documentId)`. Šifrat premješten na drugi rad (npr. izmjenom u bazi) ne dešifrira se.
- **Što je unutra:** `JCS({text, place})`, nadopunjeno nulama do točno 1280 bajtova prije šifriranja, da duljina šifrata ne odaje duljinu poruke. 280 znakova je najviše 1120 bajtova UTF-8, a položaj oko 70 bajtova, pa sve stane. Šifrat je uvijek 1280 + 16 (oznaka GCM) = 1296 bajtova.
- **Položaj poruke (`place`) ide u šifrat** (odluka vlasnika, točka 2: „Da”): odaje gdje je student ostavio bilješku. Položaj čitanja ostaje nešifriran.
- **Nitko ne vraća ključ umjesto studenta:** ni operater, ni fakultet, ni referada, ni podrška. Sučelje to kaže jasno pri postavljanju, prije prve poruke.
- **D-09 ostaje netaknut.** Fraza ili kod iz varijanti niže **nisu način prijave**: ne šalju se poslužitelju, ne otvaraju sesiju i ne zamjenjuju AAI@EduHr. Student se i dalje prijavljuje samo preko AAI@EduHr; fraza samo otključava poruke na uređaju. Da se ne pomiješa s prijavom, u sučelju se ne zove „lozinka” (naziv ide kroz katalog poruka i skener u WEB repou).

## 3. Varijante

### Varijanta A: ključ izveden iz posebne fraze

Ključ poruka nije slučajan, nego se izvodi iz fraze koju student unese: `DEK = KDF(fraza, sol)`. Poslužitelj čuva samo sol, parametre KDF-a i kontrolni šifrat (npr. šifrirani prazan niz) da se kriva fraza prepozna odmah.

- **Drugi uređaj:** student unese frazu, uređaj izvede isti ključ.
- **KDF:** WebCrypto ima samo PBKDF2. Za frazu koju student sam smišlja treba Argon2id (WASM biblioteka, nova ovisnost) ili PBKDF2-SHA-256 s najmanje 600 000 iteracija i pravilom najmanje duljine. Bolje: aplikacija frazu **generira** (npr. 6 skupina po 4 znaka base32, oko 120 bita), pa PBKDF2 dostaje i nova ovisnost nije potrebna.
- **Promjena fraze:** mijenja ključ, pa uređaj mora dešifrirati i ponovno šifrirati sve poruke (jedna po radu, malo podataka) i zamijeniti sol u istom koraku. Prekid usred toga ostavlja poruke pod dva ključa; treba verziju ključa po poruci.
- **Gubitak fraze:** sve poruke su trajno nečitljive. Student ih može samo obrisati i započeti s novom frazom.
- **Napad na kopiju baze:** s kopijom (sol + šifrati) napadač pogađa frazu izvan sustava, bez ograničenja broja pokušaja. Generirana fraza od oko 120 bita to čini neizvedivim; fraza koju student smisli ne.
- **Prednost:** najjednostavnija, nema omotanog ključa. **Mana:** jedna tajna, nema oporavka, promjena fraze je skupa.

### Varijanta B: slučajni ključ omotan frazom, uz kod za oporavak

Ključ poruka je slučajan. Uređaj ga omota (AES-KW ili AES-GCM) ključem izvedenim iz fraze (KEK) i, posebno, ključem izvedenim iz **koda za oporavak** koji aplikacija generira i student spremi izvan Ducture (ispis, upravitelj lozinki). Poslužitelj čuva oba omotana ključa, soli i parametre.

- **Drugi uređaj:** student unese frazu, uređaj odmota ključ. Zaboravljena fraza: student unese kod za oporavak i postavi novu frazu.
- **Promjena fraze:** samo ponovno omatanje ključa (jedan zapis); poruke se ne diraju.
- **Gubitak:** poruke su izgubljene tek ako su izgubljeni i fraza i kod za oporavak.
- **Dvije podvarijante (izbor vlasnika):**
  - **B1:** frazu student smišlja sam (lakše pamćenje), kod za oporavak je generiran. Slabija točka je fraza pri napadu na kopiju baze; treba Argon2id ili PBKDF2 s visokim brojem iteracija i pravilo najmanje duljine.
  - **B2:** i fraza i kod su generirani (u praksi jedan generirani kod i jedan rezervni). Najjači otpor napadu na kopiju, bez nove ovisnosti; teže za pamćenje, pa ga student mora negdje spremiti.
- **Prednost:** oporavak bez poslužitelja, jeftina promjena fraze, ključ poruka se nikad ne mijenja. **Mana:** student pri postavljanju dobiva kod koji mora spremiti; dva omotana zapisa.

### Varijanta C: prijenos ključa s uređaja na uređaj

Ključ poruka postoji samo na studentovim uređajima. Novi uređaj (nakon prijave preko AAI@EduHr) napravi privremeni par ključeva ECDH P-256 i pošalje javni ključ preko poslužitelja; uređaj koji već ima ključ omota ga dogovorenim ključem (ECDH + HKDF + AES-GCM) i pošalje natrag. Poslužitelj samo prenosi omotane podatke i briše ih nakon preuzimanja ili isteka (npr. 10 minuta).

- **Zaštita od podmetanja:** poslužitelj bi mogao podmetnuti svoj javni ključ. Zato oba uređaja prikažu kratki kod usporedbe (npr. 6 znamenki iz hasha oba javna ključa), a student potvrdi da je isti. Bez te potvrde varijanta ne štiti od operatera.
- **Drugi uređaj:** student mora imati pri ruci uređaj na kojem je ključ otključan.
- **Sukob s odjavom:** odjava briše ključ (§2). Student koji se odjavio na jedinom uređaju više nema izvor ključa i gubi poruke. Zato **C sama ne ispunjava uvjet „dostupno na drugom računalu”** za studenta s jednim računalom ili samo fakultetskim računalima. Upotrebljiva je samo kao **dodatak varijanti B** (brže otključavanje novog uređaja bez fraze), ili kad bi vlasnik dopustio da ključ preživi odjavu na osobnom uređaju, što mijenja pravila odjave i nije preporučeno.
- **Prednost:** nema fraze ni koda kad je drugi uređaj pri ruci. **Mana:** najsloženija (dodatne rute, istek, usporedba koda), sama ne radi s brisanjem pri odjavi.

### Usporedba

|                                    | A: fraza                 | B: omotani ključ + oporavak  | C: uređaj na uređaj         |
| ---------------------------------- | ------------------------ | ---------------------------- | --------------------------- |
| Drugo računalo                     | unese frazu              | unese frazu                  | potreban otključan uređaj   |
| Gubitak tajne                      | poruke izgubljene        | oporavak kodom               | izgubljene ako nema uređaja |
| Promjena fraze                     | ponovno šifriranje svega | ponovno omatanje ključa      | nema fraze                  |
| Napad na kopiju baze               | ovisi o jačini fraze     | ovisi o jačini fraze (B1/B2) | nema podataka za pogađanje  |
| Radi s brisanjem ključa pri odjavi | da                       | da                           | ne, samo uz B               |
| Nova ovisnost                      | samo ako Argon2id        | samo ako Argon2id (B1)       | ne                          |
| Opseg gradnje                      | mali                     | srednji                      | velik (i treba B)           |

**Odluka vlasnika (24. 11. 2026.): B2.** Preporuka pisca bila je ista: B2 za pilot, C kasnije kao dodatak ako se pokaže potreba. Razlog: jedina varijanta koja ispunjava oba uvjeta (drugo računalo i brisanje ključa pri odjavi) s oporavkom i bez nove ovisnosti, a pri napadu na kopiju baze otporna je bez obzira na to koliko je student pažljiv s izborom fraze.

## 4. Ugovor (izgrađen za B2, API 1.110.0)

Rute su u `server/contracts/routes/self-note-sealed.ts`. Svi bajtovi idu kao **kanonski base64url bez nadopune** točne duljine (drugi zapis istih bajtova, `=` ili znakovi `+`/`/` su 422). Identitet i ustanova nikad nisu u zahtjevu.

### 4.1 Poruka sebi: šifrat umjesto teksta

```text
SealedNote = {v: 1, keyId, iv, ct}
  v      1 (verzija omotnice i AAD-a iz §2)
  keyId  UUID ključa poruka (malim slovima); mora biti ključ koji student sada drži
  iv     točno 12 bajtova (16 znakova)
  ct     točno 1296 bajtova (1728 znakova): 1280 nadopunjenih + 16 oznake GCM
```

| Ruta                                                 | Operacija                      | Tijelo                | Odgovor 200           |
| ---------------------------------------------------- | ------------------------------ | --------------------- | --------------------- |
| `GET /api/v1/works/{documentId}/sealed-self-note`    | `work.sealed-self-note.get`    | —                     | `SealedSelfNoteState` |
| `PUT /api/v1/works/{documentId}/sealed-self-note`    | `work.sealed-self-note.put`    | `{sealed}` (do 4 KiB) | `SealedSelfNoteState` |
| `DELETE /api/v1/works/{documentId}/sealed-self-note` | `work.sealed-self-note.delete` | prazno                | `SealedSelfNoteState` |

- `SealedSelfNoteState = {note: {sealed: SealedNote, updatedAt} | null, readingPlace: {place, updatedAt} | null}`. Šifrat se vraća bajt za bajt kakav je spremljen.
- `PUT` s `keyId` koji nije ključ koji student sada drži (ili bez ključa) je **409** i ništa se ne piše; drukčiji oblik ili duljina je 422.
- Pristup: samo student vlasnik rada; svima ostalima (mentor, nastavnici zadatka, administrator) i za nepostojeći rad 404.
- U bazi: `collaboration.work_self_note` ima `note_key_id uuid`, `note_iv bytea` (točno 12), `note_ct bytea` (točno 1296) i strani ključ na ključ istog vlasnika; stupci `note_text` i `note_place` su uklonjeni.
- **Pravila teksta su na uređaju:** 1 do 280 znakova, NFC, bez kontrolnih znakova i znakova smjera provjerava klijent prije šifriranja i nakon dešifriranja; poslužitelj ih više ne može provjeriti. To je promjena jamstva iz `mentorship-follow-v1.md` §1.

### 4.2 Ključ poruka na poslužitelju (samo omotan)

Tablica `collaboration.self_note_key` (jedan redak po korisniku i ustanovi, prisilni RLS, bez izravnih prava ijedne uloge; pristup samo kroz RPC-ove) i rute:

| Ruta                                                 | Operacija                              | Svrha                                                                                                                      |
| ---------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/me/self-note-key`                       | `profile.self-note-key.get`            | `{key}`: omotani zapis ili `null`                                                                                          |
| `PUT /api/v1/me/self-note-key`                       | `profile.self-note-key.put`            | postavljanje (`ifVersion: null`, samo kad ključa nema) i ponovno omatanje (`ifVersion` = trenutačna verzija, isti `keyId`) |
| `DELETE /api/v1/me/self-note-key`                    | `profile.self-note-key.delete`         | „počni ispočetka”: u istoj transakciji briše ključ i sve šifrirane poruke studenta (ne i položaje čitanja)                 |
| `DELETE /api/v1/me/self-note-key/{keyId}?ifVersion=` | `profile.self-note-key-checked.delete` | isto, ali samo pod ključem (i, kad je `ifVersion` naveden, verzijom) koji uređaj imenuje; inače 409 (od 1.111.0)           |

```text
PUT tijelo = {v: 1, keyId, kdf: {alg: "PBKDF2-SHA-256", iterations}, phrase: Wrap, recovery: Wrap, ifVersion}
Wrap       = {salt: 16 bajtova, iv: 12 bajtova, ct: 48 bajtova (ključ od 32 + 16 oznake GCM)}
Odgovor    = {key: {v, keyId, kdf, phrase, recovery, version, updatedAt} | null}
```

- `iterations` od 600 000 do 10 000 000; svaki omot ima svoju sol, a dvije soli ne smiju biti iste.
- Svaki drugi slučaj (ključ već postoji, ključa nema, drugi `keyId`, druga verzija) je **409** i ništa se ne mijenja, pa dva uređaja ne prepisuju jedan drugoga. Verzija raste za jedan pri svakom ponovnom omatanju; `keyId` se nikad ne mijenja.
- Ključ je osobni zapis pozivatelja (`access: signed_in`): nijedan parametar ne imenuje korisnika, pa nitko ne čita ni ne mijenja tuđi ključ.
- **Brisanje pod imenovanim ključem (od 1.111.0, SRV-NF6-SIFRA-2):** uređaj šalje `keyId` koji drži i, po želji, verziju (`?ifVersion=`, decimalno od 1 do 999 999 999). Brisanje se provodi samo ako je to ključ koji student sada drži i, kad je verzija navedena, ako je to njegova trenutačna verzija. Inače je **409** i ništa se ne briše: uređaj koji je ključ pročitao prije nego što ga je drugi uređaj ponovno omotao ili obrisao ne briše ono što nije vidio. `keyId` koji nije UUID malim slovima, druga verzija ili drugi parametar upita je 422. `keyId` i verzija nisu tajni (ključ je i dalje omotan) i ne imenuju korisnika: tuđi `keyId` je 409 kao i svaki koji pozivatelj ne drži. Klijent treba koristiti ovu rutu; `profile.self-note-key.delete` bez imena ostaje u ugovoru jer bi dodavanje parametra ili odgovora 409 postojećoj ruti bila lomljiva promjena (`contracts:breaking`).
- Fraza, kod za oporavak i ključ nikad ne idu poslužitelju; zapis ne ide u logove ni u revizijski trag sa sadržajem.

### 4.3 Varijanta C

Nije dio odluke; ne gradi se.

### 4.4 Kompatibilnost i postojeći podaci (odluka vlasnika, točka 3: varijanta (b))

- Nove operacije (§4.1, §4.2) dolaze **uz** stare `work.self-note.*`. Provjera lomljive promjene (`pnpm contracts:breaking`) ostaje bez izuzeća, pa se oblik starih ruta (1.105.0) ne mijenja.
- **Stare rute od 1.110.0 ne čuvaju tekst:** `work.self-note.get` i odgovori `work.reading-place.*` uvijek imaju `note: null`; `work.self-note.delete` briše šifriranu poruku. „Dokle sam stao” (`work.reading-place.*`) radi kao prije.
- **`work.self-note.put` od 1.111.0 odbija poruku u čistom obliku (SRV-NF6-SIFRA-2):** poslužitelj tijelo pročita do granice od 4 KiB i odbaci ga nepročitano, provjeri vlasništvo kao za čitanje (svakome drugome i za nepostojeći rad 404, bez sesije 401) i vlasniku odgovori **422** `invalid_input`; tekst ne dolazi do baze ni do priključka baze, koji više nema operaciju pisanja poruke u čistom obliku. Uspješan odgovor (200) iz ugovora 1.105.0 i njegov vektor ostaju samo kao zapis oblika jer je njihovo uklanjanje lomljiva promjena; nijedan zahtjev ga više ne dobiva. Poslužitelj ne može spriječiti klijenta da tekst pošalje, ali takav klijent sada uvijek dobiva grešku umjesto prividnog uspjeha.
- **Uklanjanje starih ruta iz ugovora** je lomljiva promjena koju `contracts:breaking` odbija bez izuzeća; zato je otvoreno za vlasnika (nova glavna verzija API-ja ili izuzeće), a dotad stare rute ne čuvaju ništa čitljivo, a `PUT` odbija tekst (gore).
- Postojeći nešifrirani retci (samo izmišljeni podaci, nijedan stvarni student) brišu se migracijom `20261217150000`: redak samo s porukom nestaje, redak s položajem čitanja ostaje bez poruke. Ne prepisuju se jer poslužitelj nema ključ.
- **Izvoz podataka studentu (D-12) ne sadrži šifrat ni zapis omotanog ključa** (ispravak SRV-NF6-SIFRA-2, N1: raniji tekst tvrdio je suprotno, a koda za to nema). Ni izvoz podataka studenta (`server/database/student-data-export`) ni izvoz rada (`server/database/work-export`) ne čitaju `collaboration.work_self_note` ni `collaboration.self_note_key`. Dodavanje šifrata i omotanog ključa u izvoz je zaseban zadatak, ovdje se ne gradi. Čitljivu kopiju u svakom slučaju može napraviti samo studentov uređaj; referada i administrator ne mogu dati čitljivu poruku.

### 4.5 Rok čuvanja ključa (otvoreno za vlasnika)

**Otvoreno, ne gradi se (SRV-NF6-SIFRA-2, S3).** Za `collaboration.self_note_key` nije određen rok čuvanja. Danas redak ostaje dok ga student ne obriše (`profile.self-note-key*.delete`) ili dok postoji korisnički račun (strani ključ na `identity.user_account`); čišćenje podataka rada (`collaboration.purge_orphan_work_data`, 20261217120000) briše šifrirane poruke radova bez vlasnika, ali ne i ključ. Omotani ključ bez ijedne poruke nije čitljiv ni koristan nikome osim studentu, ali je i dalje osobni zapis. Pitanja za vlasnika:

1. Briše li se ključ kad student nema nijednu šifriranu poruku dulje od nekog razdoblja (i kojeg), ili tek s računom?
2. Što se s ključem događa kad student napusti ustanovu (završetak studija, ispis), u odnosu na rok čuvanja radova?
3. Ulazi li ključ u revizijski trag brisanja (bez sadržaja), kao ostali zapisi koje čisti zadržavanje?

Dok vlasnik ne odluči, ništa se ne mijenja: ključ se ne briše automatski.

## 5. Odluke

1. **Varijanta: B2** (vlasnik, 24. 11. 2026.). Ključ poruka je slučajan i omotan dvaput: generiranom frazom i generiranim kodom za oporavak (PBKDF2-SHA-256 iz WebCrypto, bez nove ovisnosti). Varijanta C nije dio odluke.
2. **Položaj poruke (`place`) ide u šifrat** (vlasnik: „Da”).
3. **Kompatibilnost: varijanta (b)**: nove operacije uz stare, zatim uklanjanje starih; postojeći nešifrirani retci brišu se migracijom (vlasnik: „3B”).

## 6. Kod (SRV-NF6-SIFRA)

- migracija `db/main/migrations/20261217150000_self_note_sealed.sql`;
- pgTAP `db/main/tests/242-self-note-sealed.sql` (katalog, prava, nema tekstualnih stupaca, šifrat nepromijenjen, tuđi pristup, 409/422, brisanje ključa); `237-mentorship-self-note-overview.sql` prilagođen šifratu;
- rute `server/contracts/routes/self-note-sealed.ts`, vektori `server/contracts/vectors/work.sealed-self-note.*`, `profile.self-note-key.*`;
- priključak baze `server/database/self-note-sealed/`, HTTP rub `server/http/self-note-sealed/` (montiran u `server/server.ts`);
- lažni dev server `packages/test-fakes/dev-server/self-note-sealed-routes.ts`.

Dorade SRV-NF6-SIFRA-2 (API 1.111.0):

- migracija `db/main/migrations/20261217160000_self_note_key_delete_checked.sql` (`collaboration.delete_self_note_key_checked`), pgTAP `db/main/tests/243-self-note-key-delete-checked.sql`; `242` provjerava i da Anino brisanje ključa ne dira Dorinu šifriranu poruku;
- ruta `profile.self-note-key-checked.delete` i vektori `server/contracts/vectors/profile.self-note-key-checked.delete.json`;
- `work.self-note.put` odbijen u `server/http/mentorship-follow/index.ts`; priključak `server/database/mentorship-follow/` nema pisanje poruke u čistom obliku.

Klijent (WebCrypto, generiranje fraze i koda, sučelje) je zadatak WEB-NF6-SIFRA.
