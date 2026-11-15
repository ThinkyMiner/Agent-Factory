---
name: groom
description: Propose the next few work items from the product brief, roadmap and inbox as GitHub issues for the human to rank. Invoke manually, usually once a week.
argument-hint: "[optional focus area]"
disable-model-invocation: true
---

# /groom: propose what to build next

Focus (optional): $ARGUMENTS

You propose work. The human decides what gets built and in what order. You never
edit `product/BRIEF.md` or `product/ROADMAP.md`.

1. Read `product/BRIEF.md`, `product/ROADMAP.md`, `product/INBOX.md`, and the open
   issues (`gh issue list --state open --limit 100`).
2. Take the top unfinished roadmap item. Break it into slices that each fit one
   pull request and each leave the product working.
3. Propose at most five issues. For each: a title that states the outcome, the
   problem in two sentences, a first guess at acceptance criteria, what it depends
   on, and your risk guess (R0 to R3).
4. Create each with `factory/scripts/item.sh create --proposed --title "<outcome>"`,
   the rest on stdin. Do not apply `factory:ready`; the human does that.
5. If the inbox or the code suggests the roadmap is wrong or missing something,
   append the argument to `product/INBOX.md` under today's date. Do not act on it.

Finish with a short list: the issues you created in the order you would do them,
and one sentence on why that order.
