# Security policy

## Reporting a vulnerability

Email **support@mailoh.io** with `SECURITY` in the subject. That address is the
one published on [mailoh.io](https://mailoh.io) and is monitored by the team at
TrafficFlow GmbH; there is no separate security alias yet, and we would rather
say so than publish an address nobody reads.

Please include: what you found, how to reproduce it, the version or commit you
tested, and what you think the impact is. If you have a patch, send it in the
mail rather than opening a PR.

**Do not open a public issue for a vulnerability.** Everything else — crashes,
layout bugs, wrong copy — belongs in an issue.

We will acknowledge within 5 working days, tell you our assessment and a rough
timeline, and credit you in the release notes if you want the credit. We do not
run a bug bounty. We will not threaten you for reporting in good faith.

## Scope

In scope: this repository — the macOS client, the Windows/Linux Tauri shell
(`apps/desktop`, including its CSP, its capability set and the offline guard),
the shared client UI they render, the build and packaging scripts, and the CI
workflow.

Out of scope here, but still worth reporting to the same address:
mailoh.io, mailoh.app, and the MailOh Cloud backend. None of that code lives in
this repository.

## What this build does and does not do

Worth knowing before you go looking, because the current state rules out whole
classes of issues:

- Both apps **make no network connections at all**. They run on a bundled
  fixture mailbox; there is no IMAP client, no HTTP client, no telemetry, no
  update check. The macOS app reads and writes nothing outside the process
  except the PNGs that `--shot` is explicitly asked to write.
- On Windows and Linux this is enforced three times over, and each is worth
  attacking separately: the webview's CSP is `connect-src 'none'`; the page
  replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and
  `navigator.sendBeacon` with functions that throw; and the Cloud sync client is
  aliased out of the bundle at build time and is not in this repository at all.
  The Tauri capability list is empty, so the interface can invoke no command,
  read no file and spawn no process. A way around any of that is exactly the
  kind of report we want.
- Because the interface is embedded **uncompressed**, you can audit a downloaded
  binary directly: `strings -a mailoh | grep -oE 'https?://[^ ]+' | sort -u`.
- There are **no credentials**, no keychain use, and no account.
- The CI-built artifacts are **unsigned**: ad-hoc signature only on macOS, no
  Authenticode signature on Windows, nothing on Linux. That is a distribution
  weakness we name openly in the README rather than a vulnerability to report:
  verify the artifact came from the CI run you expect, or build from source.

When the IMAP engine lands, this section will change and the threat model will be
published with it: credential storage, TLS/certificate handling, HTML rendering
and remote-content blocking, and the structural handling of sensitive mail
(one-time codes and login links are never sent to an AI provider, never
forwarded, and stored redacted).

## Supported versions

The project is a pre-1.0 preview. Only `main` is supported; fixes land there.
