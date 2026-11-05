# Security Policy

## Reporting a vulnerability

Report privately through GitHub: **Security → Advisories → Report a
vulnerability** on this repository. That channel is private between you and
the maintainer until a fix is published.

Please do **not** open a public issue for a vulnerability, and please do not
include real credentials, tokens, or customer data in a report — a redacted
excerpt is always enough.

This is a single-maintainer hobby project under a noncommercial license.
Reports are handled on a best-effort basis, with no service-level commitment
and no bug-bounty programme.

## Scope

This project orchestrates LLM agents that **execute commands, write files, and
run git operations** against repositories you point it at. The threat model
assumes the operator intends that. The following are therefore *not*
vulnerabilities:

- An agent modifying files in a repository you configured it to work on.
- An agent running a build, test, or deploy script that the repository itself
  defines.
- Prompt content influencing agent behaviour when that content comes from
  repositories or issue trackers the operator deliberately connected.

What *is* in scope:

- Anything that lets a party **other than the operator** reach the HTTP
  surfaces or influence what the agents execute.
- Secret disclosure — tokens or API keys appearing in logs, prompts,
  transcripts, HTTP responses, or committed files.
- Path traversal or sandbox escape out of the configured workspace root.
- Injection in the event log, projections, or command bus that lets an
  untrusted input forge events.

## Deployment expectations

The security model depends on these, and a report that assumes otherwise will
usually be closed as out of scope:

- **Everything binds to loopback by default, and should stay that way.** The
  four HTTP hosts default to `127.0.0.1`. The two static servers (`board-ui`,
  `manager-board`) have **no authentication of their own** and their proxies
  attach the API bearer token to every upstream request — so exposing those
  ports gives the caller authenticated access to the worker API and, for
  `manager-board`, config-write authority. Both warn loudly if bound to a
  non-loopback address.
- For multi-machine setups, reach the hosts over a private network (Tailscale,
  WireGuard, VPN) or an authenticating reverse proxy. Set
  `WORKER_API_TOKEN_V2` whenever a host is not loopback-only.
- Secrets belong in `.env` (gitignored) or the operator profile, never in
  tracked files. Tokens and API keys must never appear in log lines — key
  *names* only.

## Supported versions

There are no tagged releases. Only the current default branch is supported;
fixes land there.
