# Security policy

## Supported versions

Security fixes are provided for the latest released version (currently `1.3.x`).

## Local HTTP API

The settings panel talks to a same-origin API mounted under `/dsh-fallback`.
When the Harness `connection` service is available, every request is checked by
`connection.requestRejection(...)`, which applies DSH's Host/Origin trust rules
and browser authentication. The plugin additionally accepts only same-origin
JSON POSTs carrying the `x-dsh-fallback-request: 1` marker. The server binds to
loopback (`127.0.0.1`); it is not intended to be exposed directly to a network.

If you put a reverse proxy in front of the panel, keep its own authentication
and Host/Origin validation enabled. Do not forward arbitrary public traffic to
the plugin prefix.

## Credentials

Added account keys are written through the Harness `credentials` service under
generated `DSH_FALLBACK_*` references. The plugin never returns a key over HTTP,
never writes a key into its configuration or state file, and never logs a key.
The state file contains account labels, credential references, redacted error
messages, health counters and hashed session tags only.

The Harness credential store itself is outside this plugin. Depending on the
DSH release and platform, it may be a file protected by operating-system access
control rather than encrypted at rest (for example `~/.dsh/.credentials.yaml`).
Protect that directory, do not sync or back it up to untrusted storage, and use
full-disk encryption on the host.

## Request routing and privacy

Router fallback and pooled accounts send the request to the configured provider
routes, including fallback routes. If a fallback route belongs to a different
provider or organization, that provider receives the request content. Review
the fallback chain before enabling it for sensitive conversations.

The plugin stores no prompts, no completions and no account keys in its state
file. Session identifiers in the event log are shortened hashes, and provider
URLs/organization identifiers in stored error messages are redacted.

## Reporting a vulnerability

Open a private security advisory in this repository instead of a public issue.
Include the affected version, reproduction steps, and the impact. Please do not
include live credentials.
