# server/http/teaching-team

Rute nastavnog tima u [HTTP sloju](../../../docs/server-map.md).

## Što radi

Provjerava oblik zahtjeva i provodi ga kroz sesiju i prilagodnik baze.

## Tko ga zove

Usmjerivač poslužitelja za tri rute nastavnog tima.

## Koje podatke dira

Identifikatore kolegija, grupa, asistenata i upisanih studenata.

## Što izvozi

`createTeachingTeamRoutesFor`.

## Što ne smije uvoziti

Izravnu vezu s bazom i unutarnje module drugih područja.
