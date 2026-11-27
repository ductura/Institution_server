# server/http/teacher-submitted-version

## Što radi

`GET /api/v1/teacher/works/{documentId}/submitted-versions/{revision}` (`teacher.work.submitted-version.get`): nastavnik kolegija čita predanu reviziju rada studenta. Ruta `work.version.get` ostaje nepromijenjena.

## Tko ga zove

`server/server.ts` montira rutu; poziva je stranica „Što je student predao”.

## Koje podatke dira

Čita kroz sesiju pozivatelja; tekst provjerava hashom prije izdavanja. Čitanje upisuje redak u dnevnik pristupa.

## Što izvozi

`createTeacherSubmittedVersionRoutesFor`.

## Što ne smije uvoziti

Upotrebljava javna sučelja područja iz [Karte servera](../../../docs/server-map.md).
