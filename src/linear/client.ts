import { LinearClient } from '@linear/sdk';
import { type Config } from '../config.js';
import { type LinearIssueData } from '../types.js';
import { logger } from '../logger.js';

let client: LinearClient;

export function initLinearClient(config: Config): void {
  client = new LinearClient({
    apiKey: config.LINEAR_API_KEY,
    headers: {
      // Required for sub-issue support
      'GraphQL-Features': 'sub_issues',
    },
  });
}

/** Fetch an issue with its first sub-issue (if any) */
export async function fetchIssue(issueId: string): Promise<LinearIssueData> {
  const issue = await client.issue(issueId);
  const childrenConnection = await issue.children();
  const subIssues = childrenConnection.nodes.map((sub) => ({
    id: sub.id,
    identifier: sub.identifier,
    title: sub.title,
    description: sub.description,
  }));

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    branchName: issue.branchName,
    subIssues,
  };
}

/** Move an issue to "In Progress" state */
export async function markInProgress(issueId: string): Promise<void> {
  const issue = await client.issue(issueId);
  const team = await issue.team;
  if (!team) {
    logger.warn(`No team found for issue ${issueId}, cannot update state`);
    return;
  }

  const states = await team.states();
  const inProgressState = states.nodes.find(
    (s) => s.name.toLowerCase() === 'in progress',
  );

  if (inProgressState) {
    await client.updateIssue(issueId, { stateId: inProgressState.id });
  }
}

/** Mark an issue as "Done" */
export async function markDone(issueId: string): Promise<void> {
  const issue = await client.issue(issueId);
  const team = await issue.team;
  if (!team) {
    logger.warn(`No team found for issue ${issueId}, cannot update state`);
    return;
  }

  const states = await team.states();
  const doneState = states.nodes.find(
    (s) => s.name.toLowerCase() === 'done',
  );

  if (doneState) {
    await client.updateIssue(issueId, { stateId: doneState.id });
  }
}
