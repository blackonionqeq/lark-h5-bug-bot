import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveRepoPath } from "../config";

describe("resolveRepoPath", () => {
  it("resolves relative paths from the repository root", () => {
    expect(resolveRepoPath("test-fixtures/frontend-project")).toBe(
      resolve(import.meta.dir, "../../../test-fixtures/frontend-project")
    );
  });

  it("keeps absolute paths unchanged", () => {
    const absolutePath = resolve(import.meta.dir, "fixtures/frontend-project");
    expect(resolveRepoPath(absolutePath)).toBe(absolutePath);
  });
});
