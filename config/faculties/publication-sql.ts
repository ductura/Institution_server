import { loadFacultyConfigs } from "../../server/database/institution-config/index.ts";

const { configs, problems } = loadFacultyConfigs(process.cwd());
const config = configs.find((candidate) => candidate.faculty === process.argv[2]);

if (problems.length > 0 || config === undefined) {
  console.error(problems.join("\n") || "FACULTY_CONFIG_NOT_FOUND");
  process.exitCode = 1;
} else {
  // The loader restricts the slug and version. Hex keeps JSON entirely out of SQL quoting.
  const rules = Buffer.from(JSON.stringify(config.rules), "utf8").toString("hex");
  console.log(`BEGIN;
SET LOCAL ROLE ductus_identity;
SELECT app.publish_institution_config('${config.faculty}', ${config.version},
  convert_from(decode('${rules}', 'hex'), 'UTF8')::jsonb);
COMMIT;`);
}
