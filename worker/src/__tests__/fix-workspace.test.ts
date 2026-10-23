import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { cleanupFixBranch, commitFix, getRepoSnapshot, validateWorkspaceChanges, withPreparedFixWorkspace } from "../fix-workspace";
import { makeFixTask, makeWorkerConfig } from "../test-fixtures";
import type { FixCleanupTask } from "../../../code/src/types";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

describe("fix workspace", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRepository(): Promise<{ root: string; repo: string; commit: string }> {
    const root = await mkdtemp(join(tmpdir(), "bugbot-fix-workspace-"));
    roots.push(root);
    const repo = join(root, "frontend-project");
    await mkdir(repo);
    await git(repo, "init");
    await git(repo, "config", "user.name", "Test User");
    await git(repo, "config", "user.email", "test@example.com");
    await writeFile(join(repo, "app.ts"), "export const value = 1;\n");
    await git(repo, "add", "app.ts");
    await git(repo, "commit", "-m", "initial");
    return { root, repo, commit: await git(repo, "rev-parse", "HEAD") };
  }

  it("commits in the linked worktree without modifying the developer working tree", async () => {
    const fixture = await createRepository();
    const config = makeWorkerConfig({
      repoPath: fixture.repo,
      fixWorktreeRoot: join(fixture.root, "workspaces"),
    });
    const task = makeFixTask({
      projectName: basename(fixture.repo),
      baseCommitSha: fixture.commit,
    });

    const result = await withPreparedFixWorkspace(task, config, async (workspacePath) => {
      await writeFile(join(workspacePath, "app.ts"), "export const value = 2;\n");
      expect(await validateWorkspaceChanges(workspacePath)).toEqual(["app.ts"]);
      return commitFix(task, workspacePath, config, []);
    });

    expect(result.outcome).toBe("ready_for_verification");
    expect(result.commitSha).toBeTruthy();
    expect(await readFile(join(fixture.repo, "app.ts"), "utf-8")).toBe("export const value = 1;\n");
    expect(await git(fixture.repo, "rev-parse", result.branchName!)).toBe(result.commitSha!);

    const cleanup: FixCleanupTask = {
      taskType: "fix.cleanup",
      taskId: "cleanup-1",
      fixTaskId: task.taskId,
      traceId: task.traceId,
      projectName: task.projectName,
      requestedBy: "ou_user",
      resolution: "handled",
      branchName: result.branchName!,
      commitSha: result.commitSha!,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await cleanupFixBranch(cleanup, config);
    await expect(git(fixture.repo, "rev-parse", result.branchName!)).rejects.toThrow();
  });

  it("rejects protected manifest changes before tests or commit", async () => {
    const fixture = await createRepository();
    const config = makeWorkerConfig({ repoPath: fixture.repo, fixWorktreeRoot: join(fixture.root, "workspaces") });
    const task = makeFixTask({ projectName: basename(fixture.repo), baseCommitSha: fixture.commit });

    await expect(withPreparedFixWorkspace(task, config, async (workspacePath) => {
      await writeFile(join(workspacePath, "package.json"), "{\"scripts\":{\"test\":\"echo unsafe\"}}\n");
      await validateWorkspaceChanges(workspacePath);
    })).rejects.toThrow("不允许提交的文件");
  });

  it("captures commit and dirty state from the developer repository", async () => {
    const fixture = await createRepository();
    expect(await getRepoSnapshot(fixture.repo)).toEqual({
      projectName: basename(fixture.repo),
      commitSha: fixture.commit,
      dirty: false,
    });
    await writeFile(join(fixture.repo, "app.ts"), "dirty\n");
    expect((await getRepoSnapshot(fixture.repo)).dirty).toBe(true);
  });
});
