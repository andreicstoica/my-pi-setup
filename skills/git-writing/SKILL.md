---
name: git-writing
description: Write concise Git commit messages and pull request bodies.
---

# Git and PR Writing

Use this skill when writing a Git commit message or pull request body.

## Commit messages

- Write the subject in the imperative mood: `Update API timeout`, not `Updated API timeout`.
- Capitalize the subject.
- Keep the subject near 50 characters. Treat 72 characters as the hard limit.
- Do not end the subject with a period.
- Separate the subject from the body with one blank line.
- Wrap body paragraphs at about 72 characters.
- Use the body to explain context, what changed, and why. Do not describe implementation details that the diff makes clear.
- Keep one logical change per commit when practical.
- Put issue references or other metadata at the bottom when the project uses them.
- A subject-only message is correct when the change needs no further context.

## Pull request bodies

- Follow a repository's PR template and local contribution rules first.
- Use a short, descriptive title. Do not force the commit 50-character limit when the repository has another convention.
- Start with the outcome. Explain why the change is needed, then what changed.
- State verification performed and list relevant commands or tests.
- Call out risks, migrations, rollout needs, follow-up work, or known gaps.
- Use active voice, simple present tense where natural, and concrete terms.
- Use ASD-STE100 Simplified Technical English and Google developer documentation style: short sentences, familiar words, no hype, and no unsupported claims.

Recommended structure:

```markdown
## Summary

## Why

## What changed

## Verification

## Risks and follow-up
```

Sources:

- https://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html
- https://cbea.ms/git-commit/
- https://developers.google.com/style
