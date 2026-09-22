import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveRepoPath } from "../config";

describe("resolveRepoPath", () => {
  it("resolves relative paths from the repository root", () => {
    expect(resolveRepoPath("../my-md-reader")).toBe(resolve(import.meta.dir, "../../../../my-md-reader"));
  });

  it("keeps absolute paths unchanged", () => {
    const absolutePath = resolve(import.meta.dir, "fixtures/frontend-project");
    expect(resolveRepoPath(absolutePath)).toBe(absolutePath);
  });
});
