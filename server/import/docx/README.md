# server/import/docx

Čitač DOCX-a za uvoz (SRV-1803, M8.2), po ugovoru [import-contract](../../../docs/adr/import-contract.md) §4 i §7 i planu napada (klase Z, X, K).

- `zip.ts`: ZIP kontejner. Sve granice (broj unosa, veličina dijela i ukupno, omjer, šifriranje, putanja, duplikat) provjeravaju se iz središnjeg imenika prije raspakiravanja; dio se raspakira samo do prijavljene veličine (`fflate`, po 1 KiB ulaza), a lokalno zaglavlje, stvarna veličina i CRC-32 moraju se slagati sa središnjim imenikom.
- `xml.ts`: strogi XML s imenskim prostorima; DTD i entiteti se odbijaju (`XML_DTD`), dubina i broj atributa po elementu su ograničeni, a dekodiraju se samo pet predefiniranih entiteta i reference znakova, jednom.
- `package.ts`: pravila paketa iz ugovora za svaki tip sadržaja i svaku vezu svih `.rels` dijelova; makro, ugrađeni objekt i vanjski resurs odbijaju cijeli uvoz.
- `convert.ts`: glavni dio u dokument v2 (odlomak, naslov 1 do 3, stavka popisa, citat, podebljano, kurziv); obrisani tekst, kodovi polja, crteži i okviri ne ulaze; autor, datum i rsid se ne čitaju.
- `read-docx.ts`: cijelo čitanje stalnim redom, s granicom sadržaja odsječka (`CONTENT_TOO_LARGE`).
- `prepare.ts`: manifest s tri hasha (provjeren čitačem ugovora) i normalizirani naziv datoteke izvan svakog hasha (D-292).

Testovi grade izmišljene pakete u memoriji (`fixtures.test-support.ts`); u repou nema binarnih datoteka.
