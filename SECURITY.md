# Security Policy

## Supported Versions

Security fixes are prioritized for the latest pre-release and stable release lines.

| Version | Supported |
|---|---|
| `main` (latest stable) | Yes |
| `dev` (latest pre-release) | Yes |
| Older tags/releases | Best effort |

## Reporting a Vulnerability

If you discover a security vulnerability, report it privately by email:

- **Email:** `soumom764@gmail.com`
- **Subject:** `PullDown Security Report`

Please include:

- A clear description of the issue
- Steps to reproduce
- Impact assessment (what can be exploited)
- A proof of concept (if available)
- Your suggested remediation (optional)

## Response Process

We aim to:

- Acknowledge receipt within **72 hours**
- Provide an initial assessment within **7 days**
- Share remediation status updates until resolution

## Disclosure Policy

- Do **not** disclose vulnerabilities publicly until a fix is released.
- Coordinated disclosure is expected.
- After a fix is shipped, we may publish a security advisory/changelog note.

## Scope

This policy applies to:

- Desktop app code in this repository
- Bundled runtime integration points (engine/player wiring)
- Build/release artifacts produced from this repository

Out of scope by default:

- Third-party upstream vulnerabilities not specific to PullDown integration
- Issues requiring local admin/system compromise unrelated to app behavior

## Safe Harbor

We appreciate good-faith security research and will not pursue action for:

- Non-destructive testing
- Responsible private reporting
- Avoiding privacy violations, data destruction, and service disruption
