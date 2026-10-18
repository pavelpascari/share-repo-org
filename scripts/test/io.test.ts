import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeIo } from "../io.ts";

describe("nodeIo", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reads, writes, and lists files on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "sharerepo-io-"));
    dirs.push(dir);
    mkdirSync(join(dir, "sub"));
    nodeIo.writeText(join(dir, "a.txt"), "hello");
    expect(nodeIo.readText(join(dir, "a.txt"))).toBe("hello");
    const entries = nodeIo.listDir(dir).sort((x, y) => x.name.localeCompare(y.name));
    expect(entries).toEqual([
      { name: "a.txt", isDirectory: false, isFile: true },
      { name: "sub", isDirectory: true, isFile: false },
    ]);
  });

  it("writes messages to the console", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    nodeIo.log("info");
    nodeIo.error("problem");
    expect(log).toHaveBeenCalledWith("info");
    expect(error).toHaveBeenCalledWith("problem");
  });
});
