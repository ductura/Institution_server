# server/database/teaching-team

Prilagodnik između HTTP ruta nastavnog tima i [sloja baze](../../../docs/server-map.md).

## Što radi

Poziva RPC-e nastavnog tima (čitanje tima, prikaza i kandidata za asistente te dvije zamjene članstva) unutar transakcije otvorene iz sesije.

## Tko ga zove

HTTP rute nastavnog tima.

## Koje podatke dira

Nositelja, popis asistenata, kandidate za asistente (samo ID i ime) i članstvo u seminarskoj grupi.

## Što izvozi

`createTeachingTeam`.

## Što ne smije uvoziti

HTTP i sastavljanje poslužitelja.
