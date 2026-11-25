// DAN-1569: the Owner queue of STATE.md as data. Reads the text only; the
// queue's source of truth stays STATE.md.

export type QueueItem = {
  done: boolean;
  /** `Q-7` when the item starts with one, else the first words of the item. */
  label: string;
  text: string;
  /** Every `Rok: D. M. YYYY.` of the item, as `YYYY-MM-DD`, earliest first. */
  deadlines: string[];
};

const HEADING = /^## Owner queue\b/;
const ITEM = /^- \[( |x)\] (.*)$/;
const DEADLINE = /Rok: (\d{1,2})\. (\d{1,2})\. (\d{4})\./g;
const pad = (value: string) => value.padStart(2, "0");

/** The items under "## Owner queue", in file order. A file without the section has none. */
export function parseOwnerQueue(markdown: string): QueueItem[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start < 0) return [];
  const items: QueueItem[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = ITEM.exec(line);
    if (!match) continue;
    const text = match[2]!;
    const deadlines = [...text.matchAll(DEADLINE)]
      .map((found) => `${found[3]}-${pad(found[2]!)}-${pad(found[1]!)}`)
      .sort();
    const label =
      /^(Q-\d+)\b/.exec(text)?.[1] ??
      text
        .split(/[:(,.]/, 1)[0]!
        .trim()
        .slice(0, 40);
    items.push({ done: match[1] === "x", label, text, deadlines });
  }
  return items;
}

export type OpenItem = QueueItem & { deadline: string | null; overdue: boolean };

/**
 * The open items by their earliest deadline; items without one come last, in
 * file order. `today` is `YYYY-MM-DD`; a deadline before it is overdue.
 */
export function openByDeadline(items: readonly QueueItem[], today: string): OpenItem[] {
  return items
    .filter((item) => !item.done)
    .map((item) => {
      const deadline = item.deadlines[0] ?? null;
      return { ...item, deadline, overdue: deadline !== null && deadline < today };
    })
    .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
}
