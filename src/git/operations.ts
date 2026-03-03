import { simpleGit, type SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';
import { type Config } from '../config.js';
import { type CIStatus } from '../types.js';
import { logger } from '../logger.js';

let git: SimpleGit;
let octokit: Octokit;
let config: Config;

export function initGit(cfg: Config): void {
  config = cfg;
  git = simpleGit(config.REPO_PATH);
  octokit = new Octokit({ auth: config.GITHUB_TOKEN });
}

/** Create a branch from latest main */
export async function createBranch(branchName: string): Promise<void> {
  await git.fetch('origin', 'main');
  await git.checkoutBranch(branchName, 'origin/main');
  logger.info(`Created branch ${branchName}`);
}

/** Stage all changes, commit, and push */
export async function commitAndPush(
  branchName: string,
  issueIdentifier: string,
  title: string,
): Promise<string> {
  await git.add('-A');
  const commitMessage = `feat: [${issueIdentifier}] ${title}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`;
  await git.commit(commitMessage);
  await git.push('origin', branchName, ['--set-upstream']);

  // Get the HEAD SHA
  const log = await git.log({ maxCount: 1 });
  const sha = log.latest!.hash;
  logger.info(`Pushed branch ${branchName} (${sha})`);
  return sha;
}

/** Create a pull request via GitHub API */
export async function createPR(
  branchName: string,
  issueIdentifier: string,
  title: string,
  description: string,
): Promise<{ prNumber: number; prUrl: string }> {
  const { data } = await octokit.rest.pulls.create({
    owner: config.GITHUB_OWNER,
    repo: config.GITHUB_REPO,
    title: `[${issueIdentifier}] ${title}`,
    body: description,
    head: branchName,
    base: 'main',
  });

  logger.info(`PR #${data.number} created: ${data.html_url}`);
  return { prNumber: data.number, prUrl: data.html_url };
}

/** Poll GitHub Checks API for CI status (fallback) */
export async function checkCIStatus(ref: string): Promise<CIStatus> {
  const { data } = await octokit.rest.checks.listForRef({
    owner: config.GITHUB_OWNER,
    repo: config.GITHUB_REPO,
    ref,
  });

  if (data.total_count === 0) {
    return { conclusion: null, failedChecks: [] };
  }

  const failedChecks = data.check_runs
    .filter((run) => run.conclusion !== 'success' && run.conclusion !== null)
    .map((run) => run.name);

  const allPassed = data.check_runs.every(
    (run) => run.conclusion === 'success' || run.conclusion === 'neutral',
  );

  return {
    conclusion: allPassed ? 'success' : 'failure',
    failedChecks,
  };
}

/** Check if a branch exists on the remote */
export async function remoteBranchExists(branchName: string): Promise<boolean> {
  const remotes = await git.listRemote(['--heads', 'origin', branchName]);
  return remotes.trim().length > 0;
}

/** Delete a remote branch */
export async function deleteRemoteBranch(branchName: string): Promise<void> {
  await git.push('origin', `:${branchName}`);
}
