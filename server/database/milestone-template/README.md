# Predložak etapa (SRV-1521)

`createMilestoneTemplate(withActor)` je port baze za predložak etapa ustanove i plan etapa jednog rada.

- Predložak je verzioniran kao pravila ustanove (`institution.milestone_template_version`, samo dodavanje): popis `{title, relativeDue?, submits}` (najviše 20; `relativeDue` je cijeli broj dana od nastanka rada, 1 do 1095; `submits` je `topic_text` ili `current_version`) i zastavica `requireFinalStageApproval` (zadano `false`: predaja je neovisna o odobrenju zadnje etape). Čita i zamjenjuje ga samo administrator ustanove (`read_milestone_template`, `publish_milestone_template` s `expectedVersion`).
- Pri nastanku zadatka mentorstva (rad jedne osobe) okidač `assignment_apply_milestone_template` kopira zadnju verziju u `institution.work_milestone`. Kasnija verzija predloška ne mijenja rad koji već ima etape. Bez predloška nema etapa.
- Mentor rada mijenja plan po radu: `add_work_milestone` dodaje etapu na kraj (ne nakon konačne predaje), `apply_milestone_template_to_work` zamjenjuje etape zadnjim predloškom (samo dok nijedna etapa rada nije poslana i bez konačne predaje). Preimenovanje, rok i brisanje su SRV-1520. Plan čitaju student vlasnik i nastavnici rada (`read_work_milestone_plan`).

Greške su ZD401, ZD403, ZD404, ZD409 i ZD422; ne hvata ih ovaj port nego HTTP rub. PgTAP: `db/main/tests/221-milestone-template.sql` i redci u `030-institution-access-matrix.sql`.
