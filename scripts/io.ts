import { readdirSync, readFileSync, writeFileSync } from "node:fs";

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** The side effects scripts need, injected so their logic is testable without a real repo. */
export interface ScriptIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  readText(path: string): string;
  writeText(path: string, text: string): void;
  listDir(path: string): DirEntry[];
  log(message: string): void;
  error(message: string): void;
}

export const nodeIo: ScriptIo = {
  cwd: process.cwd(),
  env: process.env,
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, text) => writeFileSync(path, text),
  listDir: (path) =>
    readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    })),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};
