# Security Policy

## Supported versions

Patchy Cloud runs as one hosted instance, at https://cloud.patchyhq.com. Only the release it is running is supported: fixes land on `main` and ship in the next release, and there is no older version to back-port to. The `patchy` CLI is supported at the release that instance serves; rerunning its installer upgrades it.

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub Private Vulnerability Reporting](https://github.com/allisonmahmood/patchy-cloud/security/advisories/new). Do not open a public issue or publish unpatched vulnerability details.

Please include:

- The affected commit or deployment.
- Clear reproduction steps.
- The potential impact.
- Relevant, redacted logs, screenshots, configuration, or other artifacts.
- A suggested mitigation, if known.

Do not include live secrets or unnecessary personal data. Redact sensitive artifacts before submitting them.

## What to expect

Patchy Cloud is a small project under active construction, and security reports are handled on a best-effort basis. There is no guaranteed acknowledgment, update, fix, or disclosure timeline.
