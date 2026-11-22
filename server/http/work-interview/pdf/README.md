# server/http/work-interview/pdf

HTTP rub PDF-a pripreme za razgovor (SRV-1531, N-14), rub rute `work.interview-pdf.get`.

## Što radi

`GET /api/v1/works/{documentId}/interview/pdf` čita pripremu istim portom kao `work.interview.get` i vraća `{filename, pdfBase64}`. PDF sadrži točno ono što student vidi nakon poziva. Prije poziva nema ničega zajedničkog, pa je odgovor 409. Pristup provjerava baza (odnos prema radu, C-23); tuđ ili nepoznat rad je 403 ili 404.

## Tko ga zove

Aplikacija (nastavnik ili mentor rada, student vlasnik nakon poziva) i `server/server.ts`, koji ga montira.

## Koje podatke dira

Čita pripremu iz glavne baze kroz `createWorkInterviewStore`. Ništa ne piše.

## Što izvozi

`createWorkInterviewPdfRouteFor`.

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../../docs/server-map.md). Ne generira PDF sam; to radi `server/downloads`.
