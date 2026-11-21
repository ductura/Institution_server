# Privatne bilješke mentora

`createMentorNotesStore` čita bilješke kroz RLS i dodaje ih kroz `institution.create_mentor_note`. Obje operacije koriste sesiju vezanu uz transakciju i trenutačni mentorski odnos. Bilješka ostaje vezana uz mentora koji ju je napisao.
