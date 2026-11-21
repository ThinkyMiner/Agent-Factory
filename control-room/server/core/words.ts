// Plain words for the factory's terms, shared by the server (the phase strip) and the web app (tooltips).
// No imports: the web bundle takes it as it is.

export const ROUND_WORDS: Record<string, string> = {
  brief: 'the brief: what this cycle is for and which teams take part',
  positions: 'positions: each team writes its view, sealed until the round closes',
  review: 'specialist review of the positions (threat model, data)',
  decisions: 'decisions: the orchestrator drafts DECISIONS.md and each team accepts or objects',
}
export const ROUND_WORDS_EXTRA: Record<string, string> = {
  approval: 'approval: the decisions wait for your human-approved label and merge',
  dispatched: 'dispatched: the decisions became a feature branch and one issue per work item',
  escalated: 'escalated: a team took two strikes; the meeting stopped for your decision',
  closed: 'closed: the cycle ended',
}
export const roundWords = (status: string) => ROUND_WORDS[status] ?? ROUND_WORDS_EXTRA[status] ?? (status.startsWith('discussion-') ? `discussion round ${status.slice(11)}: teams ask and answer each other` : status)

/** The pipeline's stages, as /work runs them. */
export const STAGE_WORDS: Record<string, string> = {
  intake: 'intake: /work reads the issue and checks it may start',
  spec: 'spec: the spec-writer writes spec.md, its acceptance criteria and risk floor',
  tests: 'tests: the test-author writes acceptance tests that name each criterion, before any code',
  build: 'build: the builder writes the code until the tests pass',
  gate: 'gate: the checks run (tests, lint, secrets, ownership) and must all pass',
  review: 'review: an independent reviewer (and specialists for db, UI or evidence) reads the change',
  observe: 'observe: the observer records what went well or badly, for the factory to learn from',
  pr: 'pr: the pull request is opened with its risk tier; at or below the auto-merge tier it merges itself',
}

/** Other terms a newcomer meets. */
export const TERMS: Record<string, string> = {
  foreman: 'foreman: the main Claude Code session that runs /work and starts each stage’s agent',
  subagent: 'an agent the foreman started for one stage (spec-writer, test-author, builder, reviewer, observer)',
  strike: 'strike: a team missed its turn in a timed planning round; two strikes stop the meeting',
  holds: 'the work item on the branch this team’s worktree has checked out; a build slot is held separately while /work runs',
  slot: 'build slot: in team mode only a few items build at once; a team takes a slot when /work starts and gives it back at the end',
  sweep: 'the sweep: the factory’s watchdog; it rings idle teams, types the next command into free sessions and escalates what it cannot fix',
  orchestrator: 'the orchestrator: the team that runs planning, dispatch and integration',
  ticket: 'ticket: a request from one team to another (a bug, a contract change); the receiving team accepts or declines it',
}
