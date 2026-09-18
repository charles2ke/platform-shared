# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `0.2.x` | Yes |
| `< 0.2` | No |

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/charles2ke/platform-shared/security/advisories/new).
Do not open a public issue for security problems.

Include, where possible:

- affected module (`auth`, `profile`, `notifications`, `adapters`, `shared`) and version,
- reproduction steps or a proof-of-concept,
- impact assessment (authentication bypass, token forgery, data exposure, denial of service).

You should receive an acknowledgement within 3 business days and a remediation plan
or rejection within 10 business days.

## Security model of this package

This package is a library, not a service. Downstream applications own transport
security, persistence, and secret storage. The library provides:

- HS256 JWT issuing/verification built on Node's `crypto` with constant-time
  signature comparison, and explicit `issuer`/`audience`/expiry checks.
- Refresh-token rotation with replay detection that revokes the affected sessions.
- Synchronous token revocation stores so guards cannot be bypassed by an
  unawaited promise.
- Action-keyed access policies (`createAccessPolicy()`) so RBAC is enforced in
  services, jobs, and queue consumers, not just HTTP routes.
- Structured `PlatformError`s that give consumers a consistent HTTP error envelope
  (`toHttpErrorResponse()`); it does not sanitize `error.message` or `PlatformError.details`, so
  callers are responsible for not putting sensitive data into either.

## Operational requirements for consumers

- Set `PLATFORM_JWT_SECRET` to at least 32 random characters; never commit it.
- Rotate the JWT secret and treat rotation as a forced logout event.
- Back token revocation with a shared cache/store when running multiple instances;
  the in-memory store is per-process only.
- Keep access-token TTLs short (the default is 900 seconds) and prefer rotation
  over long-lived refresh tokens.
- Terminate TLS in front of any service using these guards.
- Monitor dead-letter records for notification delivery failures.

## Automated controls in this repository

- CI runs the full test suite and syntax checks on every push to `main` and every pull
  request targeting `main`.
- CodeQL (`security-extended`) scans on push to `main`, pull requests targeting `main`,
  and weekly.
- Dependabot watches npm and GitHub Actions versions weekly.
- Workflows run with least-privilege `permissions` and without persisted credentials.
