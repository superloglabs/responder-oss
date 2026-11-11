import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTarArchive } from "./tar-archive.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function extract(archive: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tar-archive-"));
  directories.push(directory);
  await writeFile(join(directory, "archive.tar"), archive);
  await run("mkdir", [join(directory, "out")]);
  await run("tar", ["-xf", join(directory, "archive.tar"), "-C", join(directory, "out")]);
  return join(directory, "out");
}

describe("createTarArchive", () => {
  it("holds every file with its exact content", async () => {
    const longName = `${"a-".repeat(49)}ab.md`;
    expect(Buffer.byteLength(longName)).toBeGreaterThan(100);
    const binary = new Uint8Array([0, 1, 2, 255]);

    const out = await extract(createTarArchive([
      { content: "- [one](one.md) — first\n", path: "MEMORY.md" },
      { content: "x".repeat(512), path: "exact-block.md" },
      { content: "", path: "empty.md" },
      { content: "Café ☕\n", path: longName },
      { content: binary, path: "binary.bin" },
    ]));

    expect((await readdir(out)).sort()).toEqual(
      ["MEMORY.md", "binary.bin", "empty.md", "exact-block.md", longName].sort(),
    );
    expect(await readFile(join(out, "MEMORY.md"), "utf8")).toBe("- [one](one.md) — first\n");
    expect(await readFile(join(out, "exact-block.md"), "utf8")).toBe("x".repeat(512));
    expect(await readFile(join(out, "empty.md"), "utf8")).toBe("");
    expect(await readFile(join(out, longName), "utf8")).toBe("Café ☕\n");
    expect(new Uint8Array(await readFile(join(out, "binary.bin")))).toEqual(binary);
  });

  it("is a whole number of blocks ending in two empty ones", () => {
    const archive = createTarArchive([{ content: "hello\n", path: "a.md" }], 0);

    expect(archive.length % 512).toBe(0);
    expect(archive.length).toBe(512 * 4);
    expect(archive.subarray(-1024).every((byte) => byte === 0)).toBe(true);
  });
});
