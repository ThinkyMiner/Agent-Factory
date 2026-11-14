# Agent Factory

A software factory for one person and Claude Code: you write what to build, agents
spec, test, build and review it one issue at a time, and deterministic gates decide
what may merge without you.

| | |
|---|---|
| [`factory-starter/`](factory-starter) | The kit: five agents, four skills (`/groom`, `/work`, `/audit`, `/reflect`), CI gates and risk tiers. [How it works](factory-starter/docs/factory/ARCHITECTURE.md). |
| [`control-room/`](control-room) | A local web app that watches a factory: what needs you, whether you can trust what merged, whether the factory is improving. |
| [`bin/factory`](bin/factory) | One command to start a factory in any folder and watch it. |

## Start a factory

Needs git, `gh` (logged in), `jq`, `make`, Node 24 or later and Claude Code.

```sh
git clone https://github.com/ThinkyMiner/Agent-Factory ~/Agent-Factory
(cd ~/Agent-Factory/control-room && npm install)
ln -s ~/Agent-Factory/bin/factory ~/.local/bin/factory     # or anywhere on your PATH

factory new ~/code/my-app "a note taking website"   # Claude Code writes the brief with you and builds a skeleton
cd ~/code/my-app && factory github                    # GitHub repo, labels, protected main
factory watch                                         # the control room, in another terminal
claude                                                # then /groom, and label the issues you want factory:ready
```

With the Claude GitHub app and a `CLAUDE_CODE_OAUTH_TOKEN` secret (`factory github`
says how), labelling an issue `factory:ready` builds it on GitHub, and a pull request
at or below `AUTO_MERGE_MAX_TIER` merges itself once CI is green. R2 changes always
wait for you; R3 changes are never made by the factory.

## Found a problem with the factory?

[Open an issue](https://github.com/ThinkyMiner/Agent-Factory/issues). Agents in a
factory made from this kit do this themselves when the factory gets in their way
(see the last rule in [`factory-starter/CLAUDE.md`](factory-starter/CLAUDE.md)).
Describe the factory problem, not your product: no code, secrets or private details.
Issues here are read by a person; nothing runs automatically from them.
