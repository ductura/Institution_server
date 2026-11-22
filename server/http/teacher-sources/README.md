# teacher-sources

HTTP rub nastavnikovih izvora (SRV-1605, Ductus#2052, WEB-2133): preporuka izvora na radu, obvezna
literatura kolegija, zahtjev za potvrdu izvora s rokom, oznaka pregledane literature i nastavnikovo
čitanje potvrda izvora (`teacher.source-*`, `teacher.course-literature.*`,
`teacher.literature-seen.put`, `student.course-literature.get`,
`student.source-proof-requests.get`). Piše samo nositelj kolegija (ili mentor rada), suradnik samo
čita; svako odbijanje je isti 404 (C-23), a `canWrite` u čitanju kaže stranici smije li nuditi
pisanje. Tko smije odlučuje baza (20261213100500).
