# server/http/teacher-work

HTTP adapter za `teacher.work.get`: `GET /api/v1/teacher/works/{documentId}` (SRV-2003). Sesija odlučuje tko pita, a RPC odlučuje smije li čitati taj rad. Student, drugi nastavnik, nepoznat i neispravan id čitaju isti 404.
