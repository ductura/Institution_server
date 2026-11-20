# server/public-verification

Javna provjera potvrde predaje prema [Karti servera](../../docs/server-map.md).

## Što radi

Za dvije vrijednosti iz QR-a potvrde (id predaje i SHA-256 predanog teksta) provjerava veže li potpisana potvrda točno taj tekst (✓ C-6). Čita `app.public_receipt_verification` bez sesije, zatim sam provjerava Ed25519 potpis potvrde ključem koji je baza vratila. Odgovor je samo podudara li se, a kad se podudara još i vrijeme predaje, vrijeme potpisa i id ključa.

## Tko ga zove

`http`, ruta `public.verification.post` (`POST /api/v1/public/verification`), koju otvara javna stranica `/provjera` bez prijave. Ruta ne čita, ne izdaje i ne mijenja sesiju (D-09).

## Koje podatke dira

Samo čita: potpisanu potvrdu predaje i njezin ključ potpisa, kroz usku funkciju u glavnoj bazi. Ništa ne piše. Ime, kolegij, zadatak i tekst nikad ne izlaze iz modula.

## Što izvozi

`createPublicVerification(withActor)` i tipove odgovora (`PublicVerificationAnswer`, `PublicVerificationResult`).

## Što ne smije uvoziti

Smije uvoziti samo `domain` i `database` (tip `WithActor`).
