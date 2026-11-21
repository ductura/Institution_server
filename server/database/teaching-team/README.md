# server/database/teaching-team

Prilagodnik između HTTP ruta nastavnog tima i [sloja baze](../../../docs/server-map.md).

## Što radi

Poziva tri RPC-a unutar transakcije otvorene iz sesije.

## Tko ga zove

HTTP rute nastavnog tima.

## Koje podatke dira

Nositelja, popis asistenata i članstvo u seminarskoj grupi.

## Što izvozi

`createTeachingTeam`.

## Što ne smije uvoziti

HTTP i sastavljanje poslužitelja.
