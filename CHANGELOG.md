# Changelog

## 2.7.1 — 2026-11-20

- Prefer IPv4 DNS for iLink requests: a temporary loss of the host's public
  IPv6 address no longer turns normal IPv4 egress into a generic `fetch failed`.
- Include the underlying `fetch` cause (`ECONNRESET`, `ENOTFOUND`, …) in network
  errors and throttle repeated long-poll outage warnings.
- Guarantee a user-facing error reply if reply construction fails, record
  `lastReplyError`, and log successful replies.
- Clarify the missing-IPv6 reply: local DSH still runs, but IPv6 is required for
  phone access and the user can resend after the address recovers.

## 2.7.0 — 2026-11-19

- Daemon startup now prewarms IPv6/SSH/token access info once; concurrent
  replies and pushes share one in-flight collection (cold first message is no
  longer the full ~1.5 s collection).
- Added real Windows-interop tests: `netsh interface portproxy` output parsing
  and the fast IPv6 probe run against the local Windows host when available and
  skip cleanly elsewhere.
- Split `access-info.mjs`: IPv6 detection/probes now live in
  `runtime/ipv6-info.mjs`, with shared `shorten` in `access-helpers`.
- Split the iLink HTTP protocol and message sending into
  `runtime/ilink-client.mjs`.
- Expanded the bilingual plugin detail pages (`docs/DETAIL.md`,
  `docs/DETAIL.zh.md`) with architecture, security model, requirements, install,
  configuration, performance and limitations.

## 2.6.0 — 2026-11-19

- Renamed the project/package to **DSH WeChat ClawBot Access Bridge**
  (`dsh-wechat-clawbot-access`) and documented the standard repository name,
  GitHub description, Node `.gitignore` and MIT license choices.
- Added the phone-access purpose statement to the README (Chinese and English).
- Author metadata is now LinkADSL; removed the previous personal username from
  the package, license, changelog, docs and Git history.
- Added a Config-schema unit test and `npm ci` in CI.
- Performance: direct `netsh.exe` portproxy lookup and a stable-IPv6 fast path make repeated
  access-info collection ~230 ms (vs ~1.5 s cold); SSH host keys are cached for 60 s.
- Prepared the **awesome-dsh-plugin** community listing (no npm account required):
  GitHub install command, category `remote`, submission YAML and public/topic/age checklist.

## 2.5.0 — 2026-11-19

- Added an exported `Config` schema (`@deepseek-ai/schemastery`) so the plugin
  manager can render/validate settings; all fields are validated and defaulted.
- Split `access-info.mjs` into `access-helpers`, `ssh-info` and
  `message-format` modules; split daemon option parsing and state helpers out of
  `clawbot.mjs`.
- Added npm author metadata (`LinkADSL <lan_stone@foxmail.com>`) and a package lock
  for the new schema dependency.

## 2.4.0 — 2026-11-19

- Added configurable `sshPort` (host config, daemon `--ssh-port`, access-info detection,
  README/docs, and the refresh helper call site).
- Added an English README (`README.en.md`) and linked it from the main README.
- Added a mock iLink integration test covering QR login → token → `sendmessage`.
- Prepared release metadata (`README.en.md` in `files`, author/keywords) and documented
  community publishing blockers.

## 2.3.2 — 2026-11-19

- Documentation: added a China home-broadband network guide (`docs/NETWORK.md`)
  covering ONT/router IPv6, IPv6 firewalls, CGNAT, WSL2 portproxy, Windows and
  third-party firewalls, VPN interference and validation steps.
- Added a community publishing checklist (`docs/PUBLISHING.md`) and made the
  README environment/prerequisite-oriented (generic paths and usernames).

## 2.3.1 — 2026-11-19

- Removed the periodic status heartbeat entirely. `status.json` is now written
  on daemon start/stop and on real events only; the Host determines liveness
  from the PID, so no timer-driven writes are needed.

## 2.3.0 — 2026-11-19

Security and reliability hardening.

- **Owner pairing**: the first WeChat contact no longer becomes owner
  automatically. It becomes a pending request that must be approved in the DSH
  plugin page (`approve-owner` / `reject-owner`). `allowedUsers` remains an
  explicit operator allow-list and may claim ownership on its first message.
- **Fail-closed routes**: the custom `/wechat-clawbot/*` routes return 503 when
  the Host cannot inject the per-process route secret; the old predictable
  fallback header is gone.
- **Anti-spam denial limiter** (30 automatic denial/pairing replies per 10
  minutes) and log redaction: contact ids are masked and message text is only
  logged at `debug` level.
- **Heartbeat fixed**: the daemon refreshes status in memory every 10 s and
  writes `status.json` at most every 30 s instead of writing every 5 s.
  Liveness is determined from the PID by the Host route.
- **Push delivery compensation**: failed daily/manual pushes are persisted and
  retried with exponential backoff (up to 8 attempts), also rescheduled when a
  new reply context arrives or the daemon restarts.
- **Log rotation** now keeps up to three backups and rotates on every size
  threshold, instead of once per daemon lifetime.
- Cross-platform process command lookup (`ps` fallback when `/proc` is absent).
- Removed the obsolete portproxy/trusted-host warning checks and their dead
  code after the SSH-tunnel migration.
- Added `node --test` unit tests, `npm run check`, GitHub Actions CI,
  docs/DETAIL documents, a preview illustration, LICENSE and this changelog.

## 2.2.2 — 2026-11-18

- Bot replies include the copy-paste SSH tunnel command
  `ssh -N -L 3080:127.0.0.1:3080 -p 22 <user>@[IPv6]`.

## 2.2.1 — 2026-11-18

- Minimal reply format: timestamp, IPv6, SSH port/username, token link.
- Authorized-keys/renaming follow-up for the iPad/Termius setup.

## 2.2.0 — 2026-11-17

- SSH-tunnel access model: direct DSH network exposure removed, SSH hardening,
  host fingerprints, tunnel commands and localhost token URL in the bot info.
- Plugin page shows SSH connection and tunnel URL.
- Stale WSL-IP portproxy detection with a copyable repair command.

## 2.1.x — 2026-11-17

- Hourly IPv6 change watcher (fast `/proc`/`netsh` probe, pending-notification
  retry, baseline without an initial push), daily 15:00 push, QR login modal
  and route-secret auth recovery.

## 2.0.0 — 2026-11-17

- Pure-script rewrite: standalone runtime, no Agent/LLM token usage, QR login,
  automatic replies, controlled ownership and 15:00 daily push.
