type Author = { name: string; family?: string; given?: string };

export type SourceMetadata = {
  type: "book" | "chapter" | "article" | null;
  title: string;
  authors: Author[];
  year?: number;
} & Partial<
  Record<"journal" | "bookTitle" | "publisher" | "place" | "volume" | "issue" | "pages", string>
>;

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 1000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ").trim();
  return trimmed.length > 0
    ? trimmed
        .slice(0, max)
        .replace(/\p{Cs}$/u, "")
        .trimEnd()
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function authors(value: unknown): Author[] {
  return list(value)
    .slice(0, 50)
    .flatMap((raw): Author[] => {
      const author = record(raw);
      const family = text(author?.family, 200);
      const given = text(author?.given, 200);
      const name =
        text(author?.name, 401) ?? ([given, family].filter(Boolean).join(" ") || undefined);
      return name === undefined
        ? []
        : [{ name, ...(given && { given }), ...(family && { family }) }];
    });
}

function year(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 9999
    ? value
    : undefined;
}

function extras(fields: Record<string, string | number | undefined>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export function crossrefMetadata(work: Record<string, unknown>): SourceMetadata | null {
  const title = text(list(work.title)[0]);
  if (title === undefined) return null;
  const kind = typeof work.type === "string" ? work.type : "";
  const type = /chapter|book-section/u.test(kind)
    ? "chapter"
    : /book|monograph/u.test(kind)
      ? "book"
      : /article/u.test(kind)
        ? "article"
        : null;
  const container = text(list(work["container-title"])[0]);
  return {
    type,
    title,
    authors: authors(work.author),
    ...extras({
      year: year(list(list(record(work.issued)?.["date-parts"])[0])[0]),
      journal: type === "article" ? container : undefined,
      bookTitle: type === "chapter" ? container : undefined,
      publisher: text(work.publisher),
      place: text(work["publisher-location"]),
      volume: text(work.volume),
      issue: text(work.issue),
      pages: text(work.page),
    }),
  };
}

export function bookMetadata(book: Record<string, unknown>): SourceMetadata | null {
  const title = text(book.title);
  if (title === undefined) return null;
  const subtitle = text(book.subtitle);
  const date = text(book.publish_date);
  return {
    type: "book",
    title: text(subtitle ? `${title}: ${subtitle}` : title) ?? title,
    authors: authors(book.authors),
    ...extras({
      year: year(Number(date?.match(/\b\d{4}\b/u)?.[0])),
      publisher: text(record(list(book.publishers)[0])?.name),
      place: text(record(list(book.publish_places)[0])?.name),
    }),
  };
}
