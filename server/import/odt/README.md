# server/import/odt

Čitač ODT-a za uvoz (F4-PM2-R18, korak 3), po ADR-u [manifest uvoza v2](../../../docs/adr/import-manifest-v2.md) §2, §2a i §4 t. 3.

- `signature.ts`: ODT se prepoznaje po sadržaju: prvi unos ZIP-a je `mimetype`, spremljen bez sažimanja i bez dodatnog polja, s točno `application/vnd.oasis.opendocument.text`.
- `read-odt.ts`: cijelo čitanje stalnim redom. ZIP i XML čitaju čitači DOCX-a (`../docx/zip.ts`, `../docx/xml.ts`), pa vrijede iste granice (B-8, broj unosa, raspakirana veličina i omjer, dubina i atributi XML-a), iste putanje (bez `..`, bez apsolutne) i isto odbijanje DTD-a i entiteta. Čita se samo `META-INF/manifest.xml` i `content.xml`; `meta.xml`, `styles.xml` i `settings.xml` nikad.
- `convert.ts`: `office:text` u dokument v2 (odlomak, naslov 1 do 3, stavka popisa, citat, podebljano, kurziv, ćelije tablice kao odlomci) i tragovi: `office:annotation`, `text:changed-region` s `text:deletion` ili `text:insertion`.

Šifrirani ODT i aktivni sadržaj odbijaju se postojećim kodovima ugovora: `ZIP_ENCRYPTED`, `MACRO_PRESENT` (`Basic/`, `Scripts/`, `office:scripts` sa sadržajem, `script:*`, `office:event-listeners`) i `EMBEDDED_CONTENT` (`Object N/`, `draw:object`, `draw:object-ole`, `draw:plugin`, `draw:applet`).

Manifest v2 i ruta još ne znaju za ODT; to čeka korak 1 ADR-a (ugovor `ductus-import-manifest-v2`).

Testovi grade izmišljene pakete u memoriji; u repou nema binarnih datoteka.
