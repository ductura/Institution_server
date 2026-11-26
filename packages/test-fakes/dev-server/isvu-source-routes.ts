// The trial ISVU source on the dev fake server (SRV-V22-ISVU-POPIS; contracts
// institution.isvu-courses.get and institution.isvu-roster-imports.post). Only
// the administrator. The fake's handlers answer synchronously, so it holds a
// small invented source of its own in the shape of the server's synthetic
// adapter (server/external/isvu: invented courses and students, no network, no
// secret); the setting of the one fake institution is `mock`. The preview is
// the fake's roster import preview of the source's rows, so a student without
// an account is unknown_account and an enrolled one already_enrolled, as on
// the real server.
import { ROSTER_IMPORT_HANDLERS } from "./roster-import-routes.ts";
import type { Handlers } from "./server.ts";

type Person = {
  readonly identifier: string;
  readonly givenName: string;
  readonly familyName: string;
};
const person = (user: string, givenName: string, familyName: string): Person => ({
  identifier: `${user}@demo.ductus.test`,
  givenName,
  familyName,
});
const COURSES = [
  {
    sourceCourseKey: "SYN-101",
    name: "Izmišljeni seminar iz ekologije grada",
    academicYear: "2026/2027",
    roster: [
      person("demo-student", "Lucija", "Đaković"),
      person("demo-student-2", "Marko", "Ljubić"),
      person("demo-izvor-1", "Ela", "Probić"),
    ],
  },
  {
    sourceCourseKey: "SYN-201",
    name: "Izmišljeni seminar iz prošlogodišnje teme",
    academicYear: "2025/2026",
    roster: [person("demo-izvor-2", "Tin", "Uzorak")],
  },
] as const;
const ACADEMIC_YEAR = /^\d{4}\/\d{4}$/;
const quoted = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
const csvOf = (rows: readonly Person[]) =>
  [
    "identifikator;ime;prezime",
    ...rows.map((r) => [r.identifier, r.givenName, r.familyName].map(quoted).join(";")),
  ].join("\r\n") + "\r\n";

export const ISVU_SOURCE_HANDLERS: Handlers = {
  "institution.isvu-courses.get": ({ account, header, query }) => {
    const site = header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return { error: "forbidden" };
    if (account === null) return { error: "unauthorized" };
    const year = query.academicYear;
    if (Object.keys(query).length !== 1 || typeof year !== "string" || !ACADEMIC_YEAR.test(year)) {
      return { error: "invalid_input" };
    }
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    const courses = COURSES.filter((course) => course.academicYear === year).map((course) => ({
      sourceCourseKey: course.sourceCourseKey,
      name: course.name,
      academicYear: course.academicYear,
      enrolledCount: course.roster.length,
    }));
    return { status: 200, body: { mode: "mock", courses } };
  },
  "institution.isvu-roster-imports.post": (context) => {
    const { account, body } = context;
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    const course = COURSES.find((one) => one.sourceCourseKey === body.sourceCourseKey);
    if (course === undefined) return { error: "not_found" };
    const delegate = ROSTER_IMPORT_HANDLERS["institution.roster-imports.post"]!;
    return delegate({
      ...context,
      body: { source: "isvu", csv: csvOf(course.roster) },
    } as never) as never;
  },
};
