# server/domain/document

Dio Ductusova `src/domain/document` na `d52a92c3` (S-0.19, DAN-732) koji trebaju `forensics` i `evidence`: shema i provjera kanonskog dokumenta (`schema`, `validate`, `validate-sources`, `forbidden`), koraci uređivanja (`edit-step`), revizija nula i snimka (`revision-zero`, `snapshot`).

Preneseni su testovi tih datoteka koji ne traže ništa izvan prenesenog. `edit-step.test.ts` i `edit-step.property.test.ts` nisu, jer uvoze Ductusov uređivač (`src/editor`, Tiptap); koraci uređivanja provjereni su ovdje kroz `edit-step-v2.test.ts` i testove u `forensics`.

Uvozi samo `../json` i `../forensics` (`snapshot.ts` sažima JCS-om; isti krug postoji u Ductusu).
