# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
open the **Security** tab of this repository and choose **Report a vulnerability**. If that is not
available to you, contact the maintainer directly rather than filing publicly.

Please include what you found, how to reproduce it, the version you tested, and what you believe the
impact is. You will get an acknowledgement, and credit in the advisory unless you would rather not be
named.

## What this project is

AI-Provider Router is a **local-first desktop application**. It runs on your machine, binds its
gateway to `127.0.0.1` only, and holds provider credentials in the OS keychain. There is no hosted
component and no service to attack.

That shape is what makes a vulnerability here meaningful: the interesting failures are the ones
where something leaves the machine that should not, or where a local process reaches something it
should not.

## In scope

- **Credential handling.** Any path by which an API key, the gateway master key, or a per-app
  gateway key can be read from disk, logged, rendered into the UI, or sent anywhere other than the
  provider it belongs to. Keys live in the OS keychain, so a key written to disk is a bug by
  definition.
- **Gateway authentication.** Bypassing the master-key check, forging or replaying a per-app key, or
  reaching a provider without presenting a credential. The master-key check runs *before*
  authentication, so an unauthenticated request that is served is a finding.
- **Egress.** Anything that widens where the app will send data: the egress allowlist, redirect
  handling, or a request to a host the user never configured.
- **Local privilege.** Anything that lets a process other than the app reach the gateway's
  privileged surface, or that widens the hidden worker window's capability set beyond event
  listen/unlisten.
- **Memory-layer scoping.** Recall returning atoms the current principal, project or agent should
  not see. The gateway and the assistant enforce scope separately; a leak through either is in
  scope.
- **The sandboxed tool executor.** Escaping the working directory, or running a command the declared
  policy should have refused.

## Out of scope

- **What you choose to send a provider.** If you ask a model something, that content goes to the
  provider you configured. That is the product working as designed.
- **A provider's own security.** Report those to the provider.
- **An attacker who already has your unlocked user account.** The keychain is protected by your
  login. A local attacker with your session is not the boundary this project defends.
- **The gateway being reachable from your own machine.** It binds to `127.0.0.1` on purpose so that
  local tools can use it. LAN exposure would be a finding; localhost is not.
- **Ad-hoc signing on a build you compiled yourself.** See *Distribution* below.

## Distribution and signing

Release builds are intended to be signed with a Developer ID certificate and notarized by Apple. The
release workflow reads those credentials from repository secrets — they are deliberately **not**
committed to `tauri.conf.json`, because no CI job runs a full `tauri build`, so a pinned identity
there would be invisible to every check this repository has.

Two consequences worth knowing before you report something:

- A build you compiled locally is **ad-hoc signed**. macOS treats a notarized release and a local
  build as different signing identities, and keychain access is bound to the identity. So the first
  launch after switching between them prompts once, and until you approve it every gateway request
  answers `503 master key unavailable`. That prompt is expected, not a vulnerability.
- If you downloaded a build that is **not** notarized, treat that as a supply-chain problem and
  report it privately.

## Supported versions

The latest release receives security fixes. This is a small project with no long-term support
branches, and older releases are not patched.
