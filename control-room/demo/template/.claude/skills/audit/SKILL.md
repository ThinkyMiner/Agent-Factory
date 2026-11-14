---
name: audit
description: Produce the weekly factory audit of merged pull requests, a sample for the human to read, recurring failure patterns and proposed factory fixes. Invoke manually.
argument-hint: "[since YYYY-MM-DD, default 7 days ago]"
disable-model-invocation: true
---

# /audit: the after-the-fact review

Since: $ARGUMENTS

Auto-merge is only safe if someone looks afterwards. This report is that look. Be
factual and do not grade the factory generously.

1. Work out the start date (argument, or seven days before `date -I`).
2. List merged pull requests:
   `gh pr list --state merged --search "merged:>=<date>" --limit 200 --json number,title,labels,additions,deletions,mergedAt,url`
3. For each one, read `work/<id>-<slug>/log.md` and `review.md` if present.
4. Write `docs/factory/audits/<today>.md` with:
   - Counts: items merged, by risk tier; auto-merged versus human-merged; items
     that stopped as BLOCKED; fix rounds per stage; reverts and follow-up fixes
     (a pull request that repairs an earlier one counts as an escaped defect).
   - Read list for the human: every R2 item, plus three R0 or R1 items chosen at
     random (use `shuf`), with links. Say they were chosen at random.
   - Patterns: blocking findings that recur across reviews, criteria the
     test-author could not test, assumptions the spec-writer keeps making.
   - Proposed factory changes: for each pattern, the specific edit to CLAUDE.md,
     an agent prompt, a risk rule, a lint rule or a test that would prevent it.
     Describe the edit. Do not apply it.
   - Autonomy recommendation: keep, raise or lower `AUTO_MERGE_MAX_TIER`, with the
     evidence. Recommend lowering after any escaped defect in an auto-merged item.
5. Do not edit anything except the audit file.
