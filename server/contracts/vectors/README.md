# Vektori ugovora

Primjeri zahtjeva i odgovora za svaku rutu iz `server/contracts` (S-1H.4, DAN-739). Jedna datoteka po ruti, ime je ID rute (`platform.ready.get.json`). Lažni server (U8) vraća upravo ove odgovore, a prenesena ruta je gotova kad ih server prolazi.

Oblik datoteke opisuje `VectorFileSchema` u [`../vectors.ts`](../vectors.ts): `route` i popis `vectors`, svaki s `name`, `kind` (`success` ili `error`), `code` za grešku, `request` (`params`, `query`, `headers`, `body` ili `rawBody`) i `response` (`status`, `contentType`, `headers`, `body`).

`server/contracts/vectors.test.ts` pada ako:

- ruta nema datoteku ili datoteka nema rutu;
- ruti nedostaje vektor za neki status uspjeha ili za neku grešku iz njezine sheme;
- odgovor ne odgovara shemi rute (tijelo greške, vlastita shema, bez tijela, HTML stranica);
- zahtjev vektora uspjeha ne prolazi validaciju ulaza iz ugovora.

Pravila:

- Vektor se ne preimenuje i ne briše; novi slučaj dobiva novi `name`. Kako se ugovor mijenja, svi postojeći vektori moraju i dalje prolaziti.
- Svi podaci su izmišljeni: domene `.invalid`, izmišljeni tokeni i kodovi, nikad stvarni korisnik ni rad.
