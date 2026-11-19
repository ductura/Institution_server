// The server has no DOM library (tsconfig lib is ES2023 only). These are the
// few members of the browser events and elements the copied editor code reads;
// on the server the replayer only builds the schema, and none of them run.
export type HTMLElement = { getAttribute(name: string): string | null };

export type KeyboardEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isTrusted: boolean;
};

export type CompositionEvent = { type: string; data: string; isTrusted: boolean };
