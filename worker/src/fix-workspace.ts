import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FixCheckResult, FixCleanupTask, FixTask, FixTaskOutcome, RepoSnapshot } from "../../code/src/types";
import type { WorkerConfig } from "./config";

type CommandResult = { exitCode: number | null; stdout: string; stderr: string };
type WorkspaceState = {
  schemaVersion: 1;
  projectName: string;
  repoPath: string;
  remoteUrl: string;
  createdAt: string;
  activeFixTaskId: string | null;
  dependencyLockHash: string | null;
};

async function run(command: string[], cwd: string, timeoutSeconds = 600): Promise<CommandResult> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutSeconds * 1000);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);
  clearTimeout(timer);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function mustRun(command: string[], cwd: string, timeoutSeconds?: number): Promise<string> {
  const result = await run(command, cwd, timeoutSeconds);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 500)}`);
  }
  return result.stdout;
}

export async function getRepoSnapshot(repoPath: string): Promise<RepoSnapshot> {
  const commitSha = await mustRun(["git", "rev-parse", "HEAD"], repoPath);
  const status = await mustRun(["git", "status", "--porcelain"], repoPath);
  return { projectName: basename(resolve(repoPath)), commitSha, dirty: status.length > 0 };
}

function ensureChild(root: string, target: string): void {
  const relativePath = relative(resolve(root), resolve(target));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`工作区路径不在 FIX_WORKTREE_ROOT 内: ${target}`);
  }
}

async function getRemote(repoPath: string): Promise<string> {
  const result = await run(["git", "remote", "get-url", "origin"], repoPath);
  return result.exitCode === 0 ? result.stdout : "";
}

async function gitCommonDir(repoPath: string): Promise<string> {
  const value = await mustRun(["git", "rev-parse", "--git-common-dir"], repoPath);
  return realpath(resolve(repoPath, value));
}

function paths(config: WorkerConfig) {
  const projectName = basename(resolve(config.repoPath));
  if (!projectName || projectName === "." || projectName === "..") throw new Error("无法从 REPO_PATH 推导项目名");
  const projectRoot = join(config.fixWorktreeRoot, projectName);
  const workspacePath = join(projectRoot, "repo");
  ensureChild(config.fixWorktreeRoot, projectRoot);
  return {
    projectName,
    projectRoot,
    workspacePath,
    statePath: join(projectRoot, "workspace.json"),
    lockPath: join(projectRoot, "task.lock"),
  };
}

async function readState(path: string): Promise<WorkspaceState | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf-8")) as WorkspaceState;
}

async function writeState(path: string, state: WorkspaceState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath: string, taskId: string) {
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, taskId, createdAt: new Date().toISOString() }));
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let stale = false;
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf-8")) as { pid?: number };
      stale = typeof lock.pid !== "number" || !processIsAlive(lock.pid);
    } catch {
      stale = true;
    }
    if (!stale) throw new Error("项目已有修复任务运行中");
    await rm(lockPath, { force: true });
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, taskId, createdAt: new Date().toISOString() }));
    return handle;
  }
}

async function dependencyHash(workspacePath: string): Promise<string | null> {
  for (const file of ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock", "package-lock.json"]) {
    const path = join(workspacePath, file);
    if (existsSync(path)) return createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return null;
}

function packageManager(workspacePath: string): { command: string; install: string[] } | undefined {
  if (existsSync(join(workspacePath, "pnpm-lock.yaml"))) return { command: "pnpm", install: ["pnpm", "install", "--frozen-lockfile"] };
  if (existsSync(join(workspacePath, "bun.lock")) || existsSync(join(workspacePath, "bun.lockb"))) return { command: "bun", install: ["bun", "install", "--frozen-lockfile"] };
  if (existsSync(join(workspacePath, "yarn.lock"))) return { command: "yarn", install: ["yarn", "install", "--immutable"] };
  if (existsSync(join(workspacePath, "package-lock.json"))) return { command: "npm", install: ["npm", "ci"] };
  return undefined;
}

async function installDependenciesIfNeeded(workspacePath: string, state: WorkspaceState): Promise<void> {
  const manager = packageManager(workspacePath);
  if (!manager) return;
  const hash = await dependencyHash(workspacePath);
  if (hash === state.dependencyLockHash && existsSync(join(workspacePath, "node_modules"))) return;
  await mustRun(manager.install, workspacePath, 1200);
  state.dependencyLockHash = hash;
}

export async function withPreparedFixWorkspace<T>(
  task: FixTask,
  config: WorkerConfig,
  callback: (workspacePath: string) => Promise<T>
): Promise<T> {
  const p = paths(config);
  if (p.projectName !== task.projectName) throw new Error(`任务项目 ${task.projectName} 与 REPO_PATH ${p.projectName} 不一致`);
  await mkdir(p.projectRoot, { recursive: true });
  const lock = await acquireLock(p.lockPath, task.taskId).catch((error) => {
    throw new Error(`项目 ${p.projectName} 无法获取修复锁: ${(error as Error).message}`);
  });
  try {
    const repoPath = resolve(config.repoPath);
    const remoteUrl = await getRemote(repoPath);
    let state = await readState(p.statePath);
    if (state) {
      if (resolve(state.repoPath) !== repoPath || state.remoteUrl !== remoteUrl || state.projectName !== p.projectName) {
        throw new Error("已有 BugBot worktree 属于另一个仓库");
      }
    } else {
      state = {
        schemaVersion: 1,
        projectName: p.projectName,
        repoPath,
        remoteUrl,
        createdAt: new Date().toISOString(),
        activeFixTaskId: null,
        dependencyLockHash: null,
      };
    }

    if (!existsSync(p.workspacePath)) {
      await mustRun(["git", "worktree", "add", "--detach", p.workspacePath, task.baseCommitSha], repoPath);
    } else if (!existsSync(join(p.workspacePath, ".git"))) {
      throw new Error("BugBot workspace 已存在但不是 linked worktree");
    }
    if (await gitCommonDir(p.workspacePath) !== await gitCommonDir(repoPath)) {
      throw new Error("BugBot workspace 不属于当前 REPO_PATH");
    }

    state.activeFixTaskId = task.taskId;
    await writeState(p.statePath, state);
    await mustRun(["git", "switch", "--detach", task.baseCommitSha], p.workspacePath);
    await mustRun(["git", "reset", "--hard", task.baseCommitSha], p.workspacePath);
    await mustRun(["git", "clean", "-fd", "-e", "node_modules", "-e", ".pnpm-store"], p.workspacePath);
    await installDependenciesIfNeeded(p.workspacePath, state);
    await writeState(p.statePath, state);
    return await callback(p.workspacePath);
  } finally {
    const state = await readState(p.statePath).catch(() => undefined);
    if (state?.activeFixTaskId === task.taskId) {
      state.activeFixTaskId = null;
      await writeState(p.statePath, state).catch(() => undefined);
    }
    await lock.close().catch(() => undefined);
    await rm(p.lockPath, { force: true }).catch(() => undefined);
  }
}

async function changedFiles(workspacePath: string): Promise<string[]> {
  const tracked = await mustRun(["git", "diff", "HEAD", "--name-only", "--diff-filter=ACDMRTUXB"], workspacePath);
  const untracked = await mustRun(["git", "ls-files", "--others", "--exclude-standard"], workspacePath);
  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))].sort();
}

async function validateChangedFiles(workspacePath: string, files: string[]): Promise<void> {
  const protectedPatterns = [
    /(^|\/)\.env($|\.)/,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/,
    /(^|\/)package\.json$/,
    /(^|\/)(\.github|\.gitlab-ci\.yml|Jenkinsfile)(\/|$)/,
    /(^|\/)\.husky(\/|$)/,
  ];
  for (const file of files) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..") || protectedPatterns.some((pattern) => pattern.test(file))) {
      throw new Error(`修复包含不允许提交的文件: ${file}`);
    }
    const fullPath = resolve(workspacePath, file);
    try {
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) {
        const target = await realpath(fullPath);
        ensureChild(workspacePath, target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function validateWorkspaceChanges(workspacePath: string): Promise<string[]> {
  const files = await changedFiles(workspacePath);
  await validateChangedFiles(workspacePath, files);
  return files;
}

export async function runProjectChecks(workspacePath: string): Promise<FixCheckResult[]> {
  const packagePath = join(workspacePath, "package.json");
  if (!existsSync(packagePath)) return [];
  const pkg = JSON.parse(await readFile(packagePath, "utf-8")) as { scripts?: Record<string, string> };
  const manager = packageManager(workspacePath)?.command ?? "npm";
  const checks: FixCheckResult[] = [];
  for (const script of ["typecheck", "test"]) {
    if (!pkg.scripts?.[script]) continue;
    const command = manager === "yarn" ? [manager, script] : [manager, "run", script];
    const result = await run(command, workspacePath, 900);
    checks.push({
      command: command.join(" "),
      status: result.exitCode === 0 ? "passed" : "failed",
      exitCode: result.exitCode,
      summary: (result.stderr || result.stdout).slice(-1000),
    });
  }
  return checks;
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

export async function commitFix(
  task: FixTask,
  workspacePath: string,
  config: WorkerConfig,
  checks: FixCheckResult[]
): Promise<{ outcome: FixTaskOutcome; branchName?: string; commitSha?: string; changedFiles: string[] }> {
  const files = await changedFiles(workspacePath);
  if (files.length === 0) return { outcome: "no_changes", changedFiles: [] };
  await validateChangedFiles(workspacePath, files);
  await mustRun(["git", "add", "--", ...files], workspacePath);
  const issue = safePart(String(task.issueId ?? task.taskId));
  const shortTask = safePart(task.taskId.replace(/^fix-/, "")).slice(0, 8);
  const branchName = `bugfix/zentao-${issue}-${shortTask}`;
  await mustRun([
    "git",
    "-c", `user.name=${config.gitAuthorName}`,
    "-c", `user.email=${config.gitAuthorEmail}`,
    "commit", "-m", `fix: resolve Zentao bug #${task.issueId ?? task.taskId}`,
  ], workspacePath);
  const commitSha = await mustRun(["git", "rev-parse", "HEAD"], workspacePath);
  await mustRun(["git", "branch", "-f", branchName, commitSha], workspacePath);
  await mustRun(["git", "switch", "--detach", commitSha], workspacePath);
  return {
    outcome: checks.some((check) => check.status === "failed") ? "validation_failed" : "ready_for_verification",
    branchName,
    commitSha,
    changedFiles: files,
  };
}

export async function cleanupFixBranch(task: FixCleanupTask, config: WorkerConfig): Promise<void> {
  const p = paths(config);
  if (p.projectName !== task.projectName) throw new Error("清理任务项目与 REPO_PATH 不一致");
  if (!task.branchName.startsWith("bugfix/")) throw new Error("拒绝删除非 BugBot 分支");
  const actual = await mustRun(["git", "rev-parse", task.branchName], config.repoPath);
  if (actual !== task.commitSha) throw new Error("待清理分支已移动，拒绝删除");
  await mustRun(["git", "branch", "-D", task.branchName], config.repoPath);
}
