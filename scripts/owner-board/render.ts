// DAN-1569: the owner's board as one HTML file. Pure: data in, text out.
// Every section names its source and the moment it was read.
import type { OpenItem } from "./queue.ts";
import type { PullRow } from "./pulls.ts";

export type StaleIssue = {
  id: string;
  title: string;
  url: string;
  startedAt: string;
  days: number;
};

/** A section that could not be read says why; it is never shown as empty. */
export type Section<T> = { source: string; rows: T[] } | { source: string; unread: string };

export type Board = {
  generatedAt: string;
  today: string;
  queue: Section<OpenItem>;
  pulls: Section<PullRow>;
  stale: Section<StaleIssue> & { staleDays: number };
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const link = (url: string, text: string) =>
  /^https:\/\//.test(url)
    ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`
    : escapeHtml(text);
const date = (iso: string | null) => {
  if (iso === null) return "bez roka";
  const [year, month, day] = iso.slice(0, 10).split("-");
  return `${Number(day)}. ${Number(month)}. ${year}.`;
};

function table<T>(
  section: Section<T>,
  head: string[],
  row: (item: T) => string,
  empty: string,
): string {
  const source = `<p class="source">Izvor: ${escapeHtml(section.source)}</p>`;
  if ("unread" in section)
    return `${source}<p class="unread">Nije učitano: ${escapeHtml(section.unread)}</p>`;
  if (section.rows.length === 0) return `${source}<p>${escapeHtml(empty)}</p>`;
  return `${source}<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>
${section.rows.map(row).join("\n")}
</tbody></table>`;
}

const verdict = (value: string | null) => (value === null ? "nema za ovaj head" : value);
const CI = { passed: "prošao", failed: "pao", running: "u tijeku", none: "nema provjera" } as const;

export function buildBoard(board: Board): string {
  const queue = table(
    board.queue,
    ["Rok", "Stavka", "Tekst"],
    (item) =>
      `<tr${item.overdue ? ' class="overdue"' : ""}><td>${date(item.deadline)}${item.overdue ? " (prekoračen)" : ""}</td><td>${escapeHtml(
        item.label,
      )}</td><td>${escapeHtml(item.text)}</td></tr>`,
    "Nema otvorenih stavki.",
  );
  const pulls = table(
    board.pulls,
    ["PR", "Rizik", "Review", "QA", "CI", "Čeka vlasnika", "Zadnja promjena"],
    (pull) =>
      `<tr${pull.awaitsOwner ? ' class="owner"' : ""}><td>${link(pull.url, `${pull.repo}#${pull.number}`)} ${escapeHtml(pull.title)}${
        pull.draft ? " (nacrt)" : ""
      }</td><td>${pull.risk ?? "nije naveden"}</td><td>${verdict(pull.review)}</td><td>${verdict(
        pull.qa,
      )}</td><td>${CI[pull.ci]}</td><td>${pull.awaitsOwner ? "da" : "ne"}</td><td>${date(pull.updatedAt)}</td></tr>`,
    "Nema otvorenih PR-ova.",
  );
  const stale = table(
    board.stale,
    ["Zadatak", "Naslov", "U radu od", "Dana"],
    (issue) =>
      `<tr><td>${link(issue.url, issue.id)}</td><td>${escapeHtml(issue.title)}</td><td>${date(issue.startedAt)}</td><td>${issue.days}</td></tr>`,
    `Nijedan zadatak nije u radu dulje od ${board.stale.staleDays} dana.`,
  );
  return `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vlasnička ploča</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; background: #f6f5f1; color: #1f1f1d; max-width: 1200px; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 32px; }
table { border-collapse: collapse; width: 100%; } td, th { padding: 6px 10px; border-bottom: 1px solid #cfcdc4; text-align: left; vertical-align: top; }
.source, .note { font-size: 0.85rem; color: #55534c; } .unread { color: #8a2b06; }
tr.overdue td:first-child { color: #8a2b06; font-weight: 600; } tr.owner td { background: #efe6c8; }
@media (max-width: 720px) { table, tbody, tr, td { display: block; } thead { display: none; } }
</style>
</head>
<body>
<h1>Vlasnička ploča</h1>
<p class="note">Složeno ${escapeHtml(board.generatedAt)}. Ovo je pregled: statusi vrijede u svom izvoru, ne ovdje.</p>
<h2>Owner queue po roku</h2>
${queue}
<h2>Otvoreni PR-ovi</h2>
<p class="note">„Čeka vlasnika” je izvedeno ovdje: rizik critical, nije nacrt, review i QA PASS na trenutačnom headu i CI prošao. Odlučuje gate, ne ova stranica.</p>
${pulls}
<h2>Zadaci u radu dulje od ${board.stale.staleDays} dana</h2>
${stale}
</body>
</html>
`;
}
