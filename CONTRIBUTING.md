# Contributing Guide

Thanks for contributing to PullDown. This guide defines the expected engineering and review standards.

## Branching Model

- `main`: stable release branch
- `dev`: active development branch

For feature work, branch from `dev` and open PRs into `dev` unless maintainers request otherwise.

## Development Setup

1. Fork and clone the repository.
2. Install prerequisites:
   - Rust (stable)
   - Node.js 18+
3. Install dependencies:
   - `npm install`
4. Run app in development:
   - `npm run tauri dev`

## Coding Standards

### General

- Keep changes focused and minimal. Do not refactor unrelated code in the same PR.
- Prefer clear naming and small functions/modules over dense logic.
- Follow existing project architecture and folder conventions.
- Preserve platform behavior (especially Windows) when touching process/system code.

### Frontend (JS/CSS/HTML)

- Keep modules cohesive and avoid large monolithic files.
- Reuse shared helpers/components before introducing new patterns.
- Avoid breaking IPC command names/payload contracts.

### Rust Backend

- Use explicit error handling; do not silently swallow failures.
- Keep process execution safe and platform-aware.
- Add logging for operationally relevant failures and state transitions.
- Preserve separation between app/core/infrastructure/services layers.

## Testing & Validation

Before opening a PR:

- Run `cargo check --all-targets` in `src-tauri`.
- Run a local smoke test for the changed user flow.
- If packaging or installer behavior changes, validate a release build path.

## Pull Request Process

1. Create a focused branch from `dev`.
2. Write clear commits (imperative subject line).
3. Open a PR to `dev` with:
   - Problem summary
   - What changed
   - Risk/impact notes
   - Manual test steps and results
   - Screenshots/video for UI changes
4. Ensure CI/checks pass.
5. Address review comments with follow-up commits.
6. Squash/merge strategy will be decided by maintainers.

## PR Quality Bar

A PR is ready when:

- Scope is clear and limited.
- No known regressions are introduced.
- Logs/errors are actionable.
- Docs are updated when behavior changes.

## Security & Conduct

- Report vulnerabilities via [SECURITY.md](SECURITY.md).
- Follow community expectations in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
