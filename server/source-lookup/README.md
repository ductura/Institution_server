# server/source-lookup

Modul za dohvat metapodataka prema [Karti servera](../../docs/server-map.md).

## Što radi

Dohvaća jedan DOI iz Crossrefa ili jedan ISBN iz Open Libraryja. Oba kataloga
koriste isti odlazni modul i fiksne HTTPS adrese bez preusmjeravanja (D-232).
Ograničenje je jedan odlazni poziv u sekundi po katalogu i procesu. Rok je
sedam sekundi, uključujući čitanje odgovora.

## Tko ga zove

Predviđen je za poslužiteljsku rutu Brzog izvora, uz sintetičko okruženje i
kontakt operatera u User-Agentu (D-201, D-252).

## Koje podatke dira

Šalje identifikator i kontakt operatera. Predmemorija u memoriji procesa čuva
do 256 ISBN ishoda (pogodak ili izostanak) do 15 minuta.

## Što izvozi

Parser identifikatora, funkciju za stvaranje pružatelja i tipove metapodataka
te ishoda pretrage. Metapodaci se vraćaju kao običan tekst za obrazac.

## Što ne smije uvoziti

Modul nema ovisnosti o drugim područjima poslužitelja.
