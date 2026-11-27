// The few k6 modules scenarij.ts uses. k6 is a local tool (AGPL-3.0), never a
// dependency, so its types are declared here for tsc instead of installed.

declare module "k6/http" {
  export type RefinedResponse = { status: number; body: string | null; json(): unknown };
  export type Params = {
    headers?: Record<string, string>;
    tags?: Record<string, string>;
    timeout?: string;
  };
  const http: {
    get(url: string, params?: Params): RefinedResponse;
    post(url: string, body: string, params?: Params): RefinedResponse;
  };
  export default http;
}

declare module "k6" {
  export function check<T>(value: T, checks: Record<string, (value: T) => boolean>): boolean;
  export function sleep(seconds: number): void;
}

declare module "k6/data" {
  export class SharedArray<T> {
    constructor(name: string, build: () => T[]);
    readonly length: number;
    [index: number]: T;
  }
}

declare module "k6/execution" {
  const execution: { vu: { idInTest: number }; scenario: { iterationInTest: number } };
  export default execution;
}

declare function open(path: string): string;
