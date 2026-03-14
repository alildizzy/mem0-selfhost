# AGENTS.md

> Agent contract for `alildizzy/mem0-selfhost`. Read before touching anything. See CLAUDE.md for stack details.

## Identity

Commits are authored and signed by **Jonathan** (`offendingcommit`).  
Do **not** override `--author`. Do **not** use `--no-gpg-sign`.  
Jonathan's `~/.gitconfig` includeIf rules handle signing automatically.

```bash
git commit -m "type(scope): description"
```

## PR Rules

- Never merge PRs without Jonathan's review.
- Branch pattern: `feat/<issue>-<slug>`

## Pre-Action Gate

Before touching `main.py`:
1. Read the **Patches in main.py** section of `CLAUDE.md`.
2. Confirm all three patches are present in the file.
3. Confirm your change does not remove or disable any of them.

The three patches are load-bearing. Removing any one breaks the upstream mem0 integration.

## Key Files

| File | Notes |
|------|-------|
| `main.py` | Patched entrypoint — **do not remove the three patches** |
| `docker-compose.yaml` | Stack definition — port 8888 is hardcoded in openclaw-mem0 plugin |
| `.env` | Runtime secrets — gitignored, never commit |
| `.env.example` | Template for secrets — keep in sync with `.env` |
| `CLAUDE.md` | Full stack reference, patch documentation |

## The Three Patches (must always exist in main.py)

1. `_filtered_create` — strips `top_p` when `temperature` is set (Anthropic conflict)
2. `sanitize_relationship_for_cypher` — allowlist regex for Neo4j relationship names
3. `_remove_spaces_from_entities` — missing-key guard for Neo4j entity processing

## Prohibited

- Removing or disabling any of the three patches in `main.py`
- Changing port `8888` — it is hardcoded in the openclaw-mem0 plugin; changing it requires coordinated update in both repos
- `--no-gpg-sign`
- Merging PRs without Jonathan's review
- Committing `.env` (secrets must stay gitignored)
