# server/domain/forensics/golden-vectors

Testni vektori dokaza, bajt po bajt kao u Ductusu `src/domain/forensics/golden-vectors` na `d52a92c3`. Testovi čitaju i sažimaju sirove bajtove, zato su JSON datoteke izvan Prettiera (`.prettierignore`) i uvijek s LF-om (`.gitattributes`).

- `load.ts` (izvoz kroz `index.ts`): učitava `evidence-v2.json` i daje testni provjeritelj potpisa. Samo za testove.
- `ductus-docs.txt`: doslovni redci Ductusovih dokumenata s istim vektorima; jedino je privatni RFC 8032 seed zamijenjen s `<izostavljeno>`.

Ključevi su javni testni ključevi; `golden-vectors.test.ts` provjerava da nijedna datoteka ovdje ne sadrži sjeme potpisnika.
