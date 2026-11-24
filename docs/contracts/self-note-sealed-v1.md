# Šifrirana poruka sebi v1: kako student dolazi do ključa na drugom uređaju

**Status: ODLUČENO (Daniel, 24. 11. 2026.: „1. B2 2. Da 3B”; zapis orkestratora na ductura/Institution_server#676, c.7120209253).** Gradnju vode zadaci SRV-NF6-SIFRA, zatim WEB-NF6-SIFRA. Zadatak NF6-SIFRA-PRIJEDLOG (`poruka-sebi-sifriranje-prijedlog`, `Risk: critical`), nalog orkestratora na Ductus#2055 (c.7119635156). Polazište je odluka vlasnika od 24. 11. 2026. („2. Treba šifrirati da”): tekst „Poruke sebi” šifrira se na studentovu uređaju, a poslužitelj i baza čuvaju samo šifrirani tekst. Ne čita ga operater, ni netko s izravnim pristupom bazi, ni netko s kopijom (backup). Poruka mora biti dostupna i na drugom računalu. „Dokle sam stao” (položaj čitanja) ostaje nešifriran.

Ovaj dokument ne mijenja kod ni postojeći ugovor `docs/contracts/mentorship-follow-v1.md` §1. On opisuje tri varijante, njihove posljedice i promjenu ugovora koja vrijedi za svaku od njih. Gradi se tek nakon vlasnikova izbora (ovo je odluka sa statusom PRIJEDLOG čija bi promjena nakon gradnje bila skupa).

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
- **Položaj poruke (`place`) ide u šifrat** (pretpostavka pisca): odaje gdje je student ostavio bilješku. Vlasnik može odlučiti drukčije; tada `place` ostaje nešifriran kao i položaj čitanja.
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

## 4. Promjena ugovora (vrijedi za A i B; C dodaje rute iz §4.3)

### 4.1 Poruka sebi: šifrat umjesto teksta

`SelfNoteInput` i `SelfNoteState.note` umjesto `{text, place}` nose omotnicu:

```text
SealedNote = {v: 1, keyId, iv, ct}
  v      1 (verzija omotnice i AAD-a iz §2)
  keyId  UUID ključa poruka kojim je šifrirano (za promjenu ključa u A i za provjeru u B)
  iv     base64url, točno 12 bajtova
  ct     base64url, točno 1296 bajtova (1280 nadopunjenih + 16 oznake)
```

- `PUT /api/v1/works/{documentId}/self-note`: tijelo `{sealed: SealedNote}`. Bez `text` i, ako vlasnik prihvati §2, bez `place`. Tijelo ostaje do 4 KiB (omotnica je oko 1,8 KiB).
- Odgovor: `note: {sealed, updatedAt} | null`; `readingPlace` nepromijenjen.
- **Granica veličine:** poslužitelj provjerava samo oblik omotnice i točne duljine (422 inače). U bazi stupci `note_iv bytea CHECK (octet_length = 12)`, `note_ct bytea CHECK (octet_length = 1296)`, `note_key_id uuid`; stupac `note_text` nestaje.
- **Pravila teksta prelaze na uređaj:** 1 do 280 znakova, NFC, bez kontrolnih znakova i znakova smjera provjerava klijent prije šifriranja i nakon dešifriranja; poslužitelj ih više ne može provjeriti. Rizik je malen jer poruku čita samo njezin autor, ali je to promjena jamstva iz `mentorship-follow-v1.md` §1 i treba je zapisati u ugovor.
- Pristup (samo student vlasnik, 404 svima ostalima), brisanje, zadržavanje (`delete_work_self_notes`) i „Dokle sam stao” ostaju kako jesu.

### 4.2 Ključ poruka na poslužitelju (samo omotan)

Nova tablica (npr. `collaboration.self_note_key`, RLS samo za vlasnika, retci u pgTAP matrici pristupa) i rute:

| Ruta                              | Svrha                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/me/self-note-key`    | omotani zapis ili `null` (još nije postavljen)                                                                          |
| `PUT /api/v1/me/self-note-key`    | postavljanje i promjena fraze; `If-Match` na verziju zapisa da dva uređaja ne prepišu jedan drugoga                     |
| `DELETE /api/v1/me/self-note-key` | „počni ispočetka” nakon gubitka: u istoj transakciji briše zapis ključa i sve šifrirane poruke studenta (ne i položaje) |

Zapis: `{v, keyId, kdf: {alg, iterations | memory/passes, salt}, wrapped: [{slot: "phrase" | "recovery", iv, ct}]}`; u varijanti A umjesto `wrapped` dolazi kontrolni šifrat. Fiksne duljine kao u §4.1; nikad fraza, kod ni ključ u čitljivom obliku. Zapis ne ide u logove ni u revizijski trag sa sadržajem; bilježi se samo da je postavljen, promijenjen ili obrisan.

### 4.3 Samo za varijantu C

Kratkotrajni prijenos: `POST /api/v1/me/self-note-key/pairing` (novi uređaj objavljuje javni ključ, dobiva ID), `PUT .../pairing/{id}` (stari uređaj predaje omotani ključ), `GET .../pairing/{id}` (novi uređaj preuzima jednom). Zapis istječe nakon 10 minuta i briše se nakon preuzimanja; RLS samo za vlasnika.

### 4.4 Kompatibilnost i postojeći podaci

- Uklanjanje polja `text` lomi ugovor 1.105.0 i `pnpm contracts:breaking` će ga odbiti. Dvije mogućnosti: (a) lomljiva promjena istih ruta uz vlasnikovo izuzeće (WEB još ne koristi te rute u izvatku ugovora); (b) nove operacije (npr. `work.sealed-self-note.*`) uz stare, pa uklanjanje starih zasebnim zadatkom. **Odluka vlasnika: (b).**
- Postojeći nešifrirani retci (samo izmišljeni podaci, nijedan stvarni student) brišu se migracijom koja uvodi šifrat; ne prepisuju se jer poslužitelj nema ključ.
- Izvoz podataka studentu (D-12) sadrži šifrat i zapis omotanog ključa; čitljivu kopiju može napraviti samo studentov uređaj. Referada i administrator ne mogu dati čitljivu poruku.

## 5. Odluke vlasnika

1. **Varijanta: B2 (odluka vlasnika, 24. 11. 2026.).** Ključ poruka je slučajan i omotan dvaput: generiranom frazom i generiranim kodom za oporavak (PBKDF2-SHA-256 iz WebCrypto, bez nove ovisnosti). Varijanta C nije dio ove odluke; ako zatreba, dodaje se kasnije novom odlukom.
2. **Položaj poruke (`place`) ide u šifrat (odluka vlasnika, 24. 11. 2026.).** „Dokle sam stao” ostaje nešifriran.
3. **Kompatibilnost: nove operacije uz stare, pa uklanjanje starih zasebnim zadatkom (§4.4 (b); odluka vlasnika, 24. 11. 2026.).** Postojeći nešifrirani retci (izmišljeni podaci) brišu se migracijom.

Gradnja (migracija, tablica ključa s RLS-om i pgTAP retcima, rute, lažni dev server, WEB) ide kroz zadatak orkestratora; ovaj PR ostaje samo dokument. Dotad postojeći ugovor `mentorship-follow-v1.md` vrijedi nepromijenjen.
