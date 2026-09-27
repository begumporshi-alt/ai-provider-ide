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
gateway to `127.0.0.1` only, and holds provider credentials in a **file-backed secret store**:
`<data_dir>/.secrets.json`, owned by your user and written with mode `600`.

That last point is worth stating precisely, because it is the most common thing to get wrong when
reasoning about this project. **The secrets are on disk, in plaintext, by design.** There is no OS
keychain dependency and no keychain prompt — an earlier version used one and it was removed, because
a keychain item is bound to a code-signing identity and that made an unsigned development build
unable to read its own secrets. The control that replaced it is the file mode plus your user account:
the file is readable by you and by root, and by nothing else.

So the boundary is **your unlocked user account**, not the keychain. A world-readable or
world-writable `.secrets.json` is a finding; a secret sitting in that file is the documented design.

There is no hosted component and no service to attack. That shape is what makes a vulnerability here
meaningful: the interesting failures are the ones where something leaves the machine that should not,
or where a local process reaches something it should not.

## In scope

- **Credential handling.** Any path by which an API key, the gateway master key, or a per-app
  gateway key can be read by another local user, logged, rendered into the UI, or sent anywhere other
  than the provider it belongs to. This includes the mode on `<data_dir>/.secrets.json` being
  widened, the file being written somewhere another account can read, and a raw secret reaching the
  webview — TypeScript holds `secretRef` and never a secret, so a key in the DOM is a finding.
- **Gateway authentication.** Bypassing the master-key check, forging or replaying a per-app key, or
  reaching a provider without presenting a credential. The master-key check runs *before*
  authentication, so an unauthenticated request that is served is a finding. The comparison is
  constant-time, and a change that makes it observable is a finding too.
- **Egress.** Anything that widens where the app will send data: the egress allowlist, redirect
  handling, or a request to a host the user never configured. **Cleartext is part of this**: the
  egress refuses `http://` to any non-loopback host precisely because it attaches a provider
  credential to the request, so a path that puts a credential — or a pre-signed URL, which is one —
  on the wire in plaintext off-loopback is a finding.
- **The loopback HTTP surface.** The gateway's `/v1/*` and `/admin/*` routes are reachable by any
  local process, which is the point: local tools use them. What is in scope is reaching them
  *without* a credential, or escalating from a client credential to an administrative one. The UI's
  own session credential is minted per session and revoked when the gateway stops; a token that
  outlives its gateway, or one that is persisted to disk, is a finding.
- **Memory-layer scoping.** Recall returning atoms the current principal, project or agent should
  not see. The gateway and the assistant enforce scope separately; a leak through either is in
  scope.
- **The sandboxed tool executor.** Escaping the working directory, or running a command the declared
  policy should have refused.

## Out of scope

- **What you choose to send a provider.** If you ask a model something, that content goes to the
  provider you configured. That is the product working as designed.
- **A provider's own security.** Report those to the provider.
- **An attacker who already has your unlocked user account.** The secret file is protected by file
  permissions and your login. A local attacker with your session is not the boundary this project
  defends — see *What this project is*.
- **The gateway being reachable from your own machine.** It binds to `127.0.0.1` on purpose so that
  local tools can use it. LAN exposure would be a finding; localhost is not.
- **A build you compiled yourself being ad-hoc signed.** See *Distribution* below.

## Distribution and signing

Release builds are intended to be signed with a Developer ID certificate and notarized by Apple. The
release workflow reads those credentials from repository secrets — they are deliberately **not**
committed to `tauri.conf.json`, because no CI job runs a full `tauri build`, so a pinned identity
there would be invisible to every check this repository has.

Two consequences worth knowing before you report something:

- A build you compiled locally is **ad-hoc signed**. That is a supply-chain property of your own
  build rather than a vulnerability in this project — and because the secret store is a file rather
  than a keychain, it does **not** prompt for approval on first launch and does **not** affect
  whether the gateway can read its master key. If you are looking for a keychain prompt, there is
  none to find.
- If you downloaded a build that is **not** notarized, treat that as a supply-chain problem and
  report it privately.

## Supported versions

The latest release receives security fixes. This is a small project with no long-term support
branches, and older releases are not patched.
