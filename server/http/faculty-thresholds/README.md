# faculty-thresholds

HTTP edge of `institution.origin-thresholds.get`, `institution.origin-thresholds.put` and
`work.origin-thresholds.get` (SRV-1111, P-1 pravilo 12): administrator ustanove čita i zamjenjuje
pragove fakulteta po vrsti podrijetla; vlasnik rada i čitatelji rada čitaju usporedbu
(`in_line`, `for_review`, `exceeded`) samo za vrste koje imaju prag. Nema zadanih pragova. Tko smije
odlučuje baza (`app.origin_thresholds_*`, `app.work_origin_threshold_status`, 20261213100400).
Usporedba je izjava o skladu s pravilima fakulteta, ne ocjena studenta, i ništa ne blokira.
