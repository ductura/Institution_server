# server/http/peer-review

Devet ruta anonimne recenzije (val 19, SRV-V19-RECENZIJA-RUTE; ugovor [docs/contracts/peer-review-v1.md](../../../docs/contracts/peer-review-v1.md)): `createPeerReviewRoutesFor(databases.main)`.

- **Oblik:** rukovatelj provjerava oblik zahtjeva. Neispravan id u putanji je 404, a neispravno tijelo 415, 400 ili 422.
- **Pristup:** baza odlučuje tko smije što. Tuđe, nepoznato i neispravno daju isti 404 (C-23).
- **Sukobi (409):** razlog je onaj koji ruta deklarira. Nedeklarirani razlog je 503, a ne sukob pod drugim imenom.
- **Tekst recenzije:** nijedna ruta nastavnika ga ne nosi i nikad se ne zapisuje u log; log greške nosi samo klasu greške.
- **Stanje `disabled`:** nema fakultetskog prekidača ni u bazi ni u kodu, pa ga rute zasad ne vraćaju.
