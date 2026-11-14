# server/domain/evidence

Prenesen iz Ductusa `src/domain/evidence` na `d52a92c3` (S-0.19, DAN-732): osnova dokaza (`basis.ts`: tvrdnja, izvor, izvadak, procjena) i omotnica zahtjeva `commit` (`commit-envelope.ts`: verzija protokola i najveća veličina zahtjeva). U Ductusu `index.ts` izvozi samo `basis`; ovdje izvozi i `commit-envelope`, jer se ne smije uvoziti mimo `index.ts`.

Uvozi samo `../collaboration`, `../document` i `../forensics`.
