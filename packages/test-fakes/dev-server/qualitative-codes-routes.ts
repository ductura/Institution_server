// The codebook of qualitative coding on the dev fake server
// (SRV-V18-KODIRANJE-SIFRARNIK): a student's own codes, in the order of the
// codebook and never by use. Nobody else reads them: another account sees its
// own (empty) codebook, and a code that is not its own is a 404. The real rules
// are the database's; the fake keeps the codes in a WeakMap keyed by
// state.assignments (a reset of the state replaces that array, so they go
// with it) and knows no marked passages, so a delete never needs confirming.
import { createHash } from "node:crypto";

import type { Handlers } from "./server.ts";
import type { State } from "./state.ts";

type Code = { id: string; name: string; description: string; order: number };

/** The invented id of a code: of its owner and its name (the case aside), so a test can name it. */
export const fakeQualCodeId = (accountId: string, name: string): string =>
  `7c000001-0000-4000-8000-${createHash("sha256").update(`${accountId}:${name.toLowerCase()}`).digest("hex").slice(0, 12)}`;

const CODEBOOKS = new WeakMap<object, Map<string, Code[]>>();
const FAKE_CODES_MAX = 200;

function codebookOf(state: State, accountId: string): Code[] {
  let books = CODEBOOKS.get(state.assignments);
  if (books === undefined) {
    books = new Map();
    CODEBOOKS.set(state.assignments, books);
  }
  let book = books.get(accountId);
  if (book === undefined) {
    book = [];
    books.set(accountId, book);
  }
  return book;
}

const renumber = (book: Code[]): void => book.forEach((code, index) => (code.order = index + 1));
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const QUALITATIVE_CODES_HANDLERS: Handlers = {
  "student.qual-codes.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    return { status: 200, body: { codes: codebookOf(state, account.id).map((c) => ({ ...c })) } };
  },
  "student.qual-codes.post": ({ state, account, body }) => {
    if (account === null) return { error: "unauthorized" };
    const book = codebookOf(state, account.id);
    if (book.length >= FAKE_CODES_MAX || book.some((c) => sameName(c.name, body.name))) {
      return { error: "conflict" };
    }
    const code = {
      id: fakeQualCodeId(account.id, body.name),
      name: body.name,
      description: body.description ?? "",
      order: book.length + 1,
    };
    book.push(code);
    return { status: 201, body: { ...code } };
  },
  "student.qual-code.patch": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const book = codebookOf(state, account.id);
    const code = book.find((c) => c.id === params.id.toLowerCase());
    if (code === undefined) return { error: "not_found" };
    if (body.order !== undefined && body.order > book.length) return { error: "invalid_input" };
    const { name } = body;
    if (name !== undefined && book.some((c) => c !== code && sameName(c.name, name))) {
      return { error: "conflict" };
    }
    if (name !== undefined) code.name = name;
    if (body.description !== undefined) code.description = body.description;
    if (body.order !== undefined) {
      book.splice(book.indexOf(code), 1);
      book.splice(body.order - 1, 0, code);
      renumber(book);
    }
    return { status: 200, body: { ...code } };
  },
  "student.qual-code.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const book = codebookOf(state, account.id);
    const index = book.findIndex((c) => c.id === params.id.toLowerCase());
    if (index === -1) return { error: "not_found" };
    book.splice(index, 1);
    renumber(book);
    return { status: 204 };
  },
};
