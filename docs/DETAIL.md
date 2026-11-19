![WeChat phone, QR login and DSH panel connected by a QR bridge and an SSH tunnel](preview.svg)

# DSH WeChat ClawBot Access Bridge

A pure-script bridge that turns a personal WeChat account into a safe remote
access helper for **DeepSeek Harness (DSH)**. DSH stays bound to
`127.0.0.1:3080`; the phone reaches it through an SSH local port forward, and a
WeChat ClawBot (iLink) chat delivers the current IPv6 address, SSH endpoint and
token-bearing localhost URL.

The runtime is a standalone Node.js script. It does **not** create an Agent, a
session, or a model request, and it consumes **zero LLM tokens**.

## What it does

- Shows a WeChat login QR in the DSH plugin panel when the plugin starts.
- Requires explicit **owner approval** before a WeChat contact receives any
  access information.
- Replies to each WeChat message from the approved owner with:
  - the current public IPv6 address (or a clear missing-IPv6 error),
  - the SSH port, username, host-key fingerprints and a ready-to-paste tunnel
    command,
  - the current `http://127.0.0.1:3080/?token=…` URL.
- Pushes the same information every day at **15:00** and when the machine's IPv6
  address changes.
- Keeps a durable status/state file under `~/.dsh/wechat-clawbot/`, with atomic
  writes, a single-instance lock and retryable push delivery.

## How it fits together

```text
┌─────────────┐   WeChat / iLink    ┌─────────────────┐
│ Phone       │◄──────────────────►│ WeChat ClawBot  │
│  WeChat     │                    │ (iLink service) │
└──────┬──────┘                    └────────┬────────┘
       │ SSH local port forward            │ long poll / send
       ▼                                   ▼
┌──────────────────────────────────────────────────────┐
│ Windows 11 + WSL2 host                               │
│                                                      │
│  sshd ◄── SSH tunnel ── phone                        │
│    │                                                 │
│    └── 127.0.0.1:3080  DSH Web UI                    │
│                                                      │
│  DSH Host plugin ── spawns/watch ──► runtime script  │
│     │  panel, QR, owner approval, Config schema       │
│     └── access-info: IPv6 + SSH + DSH token URL      │
└──────────────────────────────────────────────────────┘
```

## Security model

- **SSH-only remote access.** DSH is never exposed on a public interface; the
  phone opens an SSH local forward and uses the `127.0.0.1` URL.
- **Owner approval.** The first unknown contact becomes a pending request; no
  access data is sent until the DSH plugin page approves that WeChat id.
- **Minimal data sharing.** The bot sends the token URL only to the approved
  owner; the token is a secret and should not be forwarded.
- **Local state.** Bot token, reply contexts and the route secret live under
  `~/.dsh/wechat-clawbot/` with restricted permissions. No telemetry or
  third-party reporting is performed.
- **No model involvement.** The runtime cannot call an LLM and does not import
  Harness packages.

See [`SECURITY.md`](../SECURITY.md) for reporting and the full threat model.

## Requirements

- Windows 10/11 with **WSL2** (Ubuntu recommended) and DSH Web;
- Node.js **20.3+**;
- a **public inbound IPv6** address and TCP SSH port (default 22) allowed on the
  ONT, router, Windows firewall and WSL `sshd`;
- an SSH client on the phone (Termius, Blink, JuiceSSH, …);
- no public IPv4, domain or DDNS required.

> IPv6/CGNAT/portproxy problems are the most common setup failure. Read
> [`NETWORK.md`](NETWORK.md) first when the QR login works but the phone cannot
> connect.

## Install

From a local checkout:

```sh
dsh plugin --profile web add /path/to/dsh-wechat-clawbot-access
```

Or from GitHub (community listing):

```sh
dsh plugin --profile web add https://github.com/LinkADSL/dsh-wechat-clawbot-access
```

Then open **Settings → Plugins → DSH WeChat ClawBot Access Bridge**, start the
runtime and scan the QR code with the phone WeChat account that should own the
bot.

## Configuration highlights

The plugin exports a validated `Config` schema; settings can be edited in the
plugin manager or in `cordis.patch.yml`.

| Setting | Default | Purpose |
|---|---|---|
| `autoStart` | `true` | Start the runtime with the plugin |
| `pushEnabled` | `true` | Daily access-info push |
| `pushHour` / `pushMinute` | `15:00` | Local-time push schedule |
| `ipv6WatchMinutes` | `60` | IPv6 change check interval (`0` disables) |
| `sshPort` | `22` | SSH port used for tunnel commands and portproxy checks |
| `maxSendChars` | `1800` | Maximum characters per WeChat message |
| `reuseTokenDays` | `30` | Reuse a confirmed bot token for this many days |
| `allowedUsers` | `[]` | Optional allow-list; empty enables pending-owner approval |

## Performance notes

- Normal reply path: one access-info collection, then formatted text.
- The daemon **prewarms** IPv6/SSH/token data once at startup; repeated
  collections reuse a stable-IPv6 fast path and cached SSH host keys.
- Measured on the development host: first cold collection ≈1.5–1.8 s; warm
  collection ≈0.2 s.
- The hourly IPv6 watcher uses `/proc` + `netsh` and invokes PowerShell only
  when the stable address actually changes.

## Limitations

- Windows + WSL2 only; Linux/macOS need a different IPv6/portproxy provider.
- IPv6 inbound access is required for the phone-side SSH tunnel. Users behind
  CGNAT should use Tailscale/WireGuard/Cloudflare Tunnel instead.
- The DSH token URL is a bearer secret; if it leaks, restart DSH to rotate the
  token and re-scan the QR if needed.
- The plugin is intentionally a thin remote-access helper, not a general
  WeChat chatbot.

## More documentation

- [Main README](../README.md)
- [Network troubleshooting](NETWORK.md)
- [Community listing checklist](PUBLISHING.md)
- [Security policy](../SECURITY.md)
