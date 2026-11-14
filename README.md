# Ductura / server

Zajednički API za sva Ductura sučelja: prijava AAI@EduHr, ovlasti, baza i pozadinski poslovi.

## Funkcionalna provjera

Korisnik može otvoriti svoj dokument, a pokušaj pristupa tuđem dokumentu bude odbijen.
Pokriva je `test/functional.test.js`.

## Pokretanje

```bash
npm start          # http://localhost:4000
npm test           # svi testovi
npm run test:helpers
npm run test:functional
```

Zahtijeva Node.js 22 ili noviji. Nema vanjskih ovisnosti.

## Stanje kostura

- Prijava: u razvoju je token samo ID korisnika (`Authorization: Bearer ana@fpzg.hr`). Zamjenjuje ga AAI@EduHr (SAML) sesija.
- Baza: memorijska (`src/store.js`). Zamjenjuje je prava baza.
- Pozadinski poslovi: još nisu dodani.

## API

| Metoda | Putanja | Opis |
|---|---|---|
| GET | `/health` | Provjera rada |
| GET | `/api/documents` | Dokumenti prijavljenog korisnika |
| GET | `/api/documents/:id` | Jedan dokument (vlasnik ili suradnik) |
| PUT | `/api/documents/:id` | Izmjena (samo vlasnik) |
