# faculty-rules

HTTP edge of `institution.faculty-rules.get` and `institution.faculty-rules.post` (SRV-2001):
an administrator of the institution reads and publishes the versions of the faculty rules per
work type. The domain is `server/institution/faculty-rules.ts`; who may, the version chain and
the audit row are the database's (`institution.publish_faculty_rule_version`, DAN-315).
