# Contributing to PullDown

Thanks for contributing. This project uses a release/stability branch model:

- `main`: stable, release-ready code only.
- `dev`: active development and pre-release integration.

## Workflow

1. Branch from `dev`:
   - `feature/<short-name>`
   - `fix/<short-name>`
   - `chore/<short-name>`
2. Keep commits focused and atomic.
3. Rebase on latest `dev` before opening a PR.
4. Open PR into `dev` (default).
5. After validation, maintainers promote selected commits from `dev` to `main` for stable releases.

## Coding Standards

- Preserve existing architecture and module boundaries.
- Prefer small files/functions with clear responsibilities.
- Handle errors explicitly; avoid silent failures.
- Keep logging actionable (`INFO/WARN/ERROR` with context).
- Avoid dead code, commented-out blocks, and unrelated refactors.
- Follow existing naming/style conventions in Rust and frontend code.
- Use production-safe defaults and deterministic behavior.

## Testing and Validation

Before opening a PR, run:

```bash
# backend
cd src-tauri
cargo check --all-targets

# if frontend/package changes were made
npm install
```

If behavior changes, include manual test notes in the PR description.

## Pull Request Requirements

Every PR should include:

- Clear summary of what changed and why.
- Scope boundaries (what is intentionally not changed).
- Risk/impact notes (runtime, UX, compatibility).
- Validation evidence (commands run, screenshots/log snippets when relevant).

PRs may be rejected if they:

- mix unrelated changes,
- bypass branch policy (`main` direct feature work),
- reduce reliability/readability,
- or ship incomplete production behavior.

## Release Notes Expectations

For user-visible changes, add concise release-note-ready bullets in the PR description:

- Added
- Changed
- Fixed
- Known limitations
