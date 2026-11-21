# server/http/time-machine

## Što radi

Vraća popis verzija, provjerenu snimku revizije i razliku između dviju poslanih revizija.

## Tko ga zove

`server/server.ts` montira rute za vlasnika rada i aktivnog mentora. Mentor može otvoriti predaju i verzije koje je student poslao kao odgovor na zahtjev za doradom.

## Koje podatke dira

Čita postojeće kontrolne točke i potvrdu predaje kroz sesiju pozivatelja. Verziju poslanu na pregled vezuje uz hash iz provjerenog nepromjenjivog segmenta. Postojeći RPC-i bilježe mentorovo čitanje.

## Što izvozi

`createTimeMachineRoutesFor` povezuje rute sa sesijom i spremištem evidencije.

## Što ne smije uvoziti

Upotrebljava javna sučelja područja iz [Karte servera](../../../docs/server-map.md).
