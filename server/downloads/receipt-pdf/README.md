# server/downloads/receipt-pdf

Generator potvrde predaje u području [preuzimanja](../README.md).

## Što radi

Iz pohranjene potpisane potvrde V2 izrađuje jednu A4 stranicu. Ispisuje podatke iz potvrde i cijeli SHA-256 otisak predanog rada. QR otvara javnu stranicu ustanove `/provjera`. Ima li predaja vezan kod potvrde, QR vodi na `/provjera#k={kod}`, a kod je ispisan ispod QR-a (dizajn 1.1, koraci 4 do 6). Potvrda bez koda (starija) ostaje ista kao prije: QR nosi identifikator potvrde i otisak, a kod se ne ispisuje. U oba slučaja vrijednosti su samo u fragmentu URL-a, pa ne stižu u zapise poslužitelja.

## Tko ga zove

Poslužiteljski adapter koji je prethodno provjerio pristup i pročitao potvrdu.

## Koje podatke dira

Čita dobivenu potvrdu, konfiguriranu adresu ustanove i hrvatske natpise iz kataloga. PDF nema metapodatke o trenutku preuzimanja.

## Što izvozi

`renderReceiptPdf` vraća PDF kao `Uint8Array`. Ugrađeni font je podskup [Noto Sans Regular](https://github.com/notofonts/noto-fonts/blob/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSans/NotoSans-Regular.ttf) s osnovnim latiničnim znakovima i hrvatskom abecedom. `receipt-font.ts` sadrži Base64 prikaz preimenovanog podskupa kako bi ga postojeći build uključio u poslužitelj. Licenca je u [OFL-Noto-Sans.txt](OFL-Noto-Sans.txt).

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../docs/server-map.md). Generator ne otvara bazu i ne poziva mrežu.
