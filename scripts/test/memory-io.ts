import type { DirEntry, ScriptIo } from "../io.ts";

/** An in-memory `ScriptIo` over absolute POSIX paths that records output and writes. */
export function memoryIo(
  cwd: string,
  initial: Record<string, string>,
  env: Record<string, string | undefined> = {},
) {
  const files: Record<string, string> = { ...initial };
  const logs: string[] = [];
  const errors: string[] = [];
  const writes: string[] = [];
  const io: ScriptIo & {
    files: typeof files;
    logs: string[];
    errors: string[];
    writes: string[];
  } = {
    cwd,
    env,
    files,
    logs,
    errors,
    writes,
    readText(path) {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return text;
    },
    writeText(path, text) {
      files[path] = text;
      writes.push(path);
    },
    listDir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = new Map<string, DirEntry>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        if (name === undefined || entries.has(name)) continue;
        const isDirectory = rest.length > 0;
        entries.set(name, { name, isDirectory, isFile: !isDirectory });
      }
      return [...entries.values()];
    },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  };
  return io;
}
