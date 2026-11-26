# server/http/work-revision-due

`GET /api/v1/works/{documentId}/revision-due` (`work.revision-due.get`, F4-NAS-R16-SRV): `{returned: {round, revisionDueAt, returnedAt} | null}`. Student vlasnik i nastavnik zadatka čitaju; tuđi rad, nepoznat rad, rad koji nikad nije predan i neispravan id su isti 404; bez sesije 401. Postojeće rute se ne mijenjaju.
