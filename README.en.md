# DSH WeChat ClawBot Access Bridge

> **Purpose**: open the DSH Web UI on your phone. Configure SSH and local port forwarding on
> the host, then ask the WeChat ClawBot for the IPv6 address and token URL and open the page in a
> phone browser.

**Repository**: <https://github.com/LinkADSL/dsh-wechat-clawbot-access> · **Package**: `dsh-wechat-clawbot-access` · **License**: MIT

A pure-script [DeepSeek Harness](https://github.com/deepseek-ai) plugin that connects a personal
WeChat account through Tencent's **ClawBot (iLink)** channel. It does **not** start an Agent or
consume LLM tokens.

## What it does

- Shows a WeChat login QR code in a Harness overlay when the plugin starts;
- Requires **explicit owner approval** for the first WeChat contact (pending-owner flow);
- Replies to every WeChat message with: timestamp, public IPv6, SSH port/username, a copy-paste
  SSH tunnel command and the current localhost DSH token URL;
- Pushes the same information daily at 15:00 and whenever the machine IPv6 address changes;
- Keeps DSH on `127.0.0.1:3080`; remote access is via an **SSH tunnel**, never by exposing 3080.

## Requirements

- Windows 10/11 with **WSL2** (Ubuntu recommended), DSH Web, Node.js **20.3+**;
- A **public IPv6 address with inbound TCP 22** (allow it on the ONT/router IPv6 firewall and in
  Windows firewall);
- An SSH client that supports local port forwarding (Termius, Blink, JuiceSSH…);
- No public IPv4, domain or DDNS required.

> Chinese home broadband adds ONT/router IPv6 and firewall pitfalls. Read
> [`docs/NETWORK.md`](docs/NETWORK.md) (Chinese with English summary) before troubleshooting.

## Quick start

```bash
plugin_manager install_bundle target=<this-directory>  # npm: dsh-wechat-clawbot-access
plugin_manager set_bundle target=<package-name> enabled=true
```

1. Open **Settings → Plugins → WeChat ClawBot**;
2. Scan the QR code shown in the overlay with WeChat;
3. Send any message to the bot, then approve the pending binding in the plugin page;
4. On the phone, add your SSH public key to the WSL `~/.ssh/authorized_keys`, configure a local
   port forward `3080 → 127.0.0.1:3080`, and open the token URL from the bot reply.

## Security

- Key-only SSH (`PasswordAuthentication no`); no public 3080 exposure.
- The bot sends the DSH token URL only to the approved owner; unknown contacts cannot receive it.
- State and logs stay local under `~/.dsh/wechat-clawbot` (0600 files, 0700 directory).
- No telemetry; the script only talks to the WeChat iLink endpoint.

## Documentation

- [`README.md`](README.md) — full Chinese guide (features, configuration, troubleshooting);
- [`docs/NETWORK.md`](docs/NETWORK.md) — Chinese network setup guide (ONT/router IPv6, firewalls,
  CGNAT, WSL portproxy, VPN interference) plus an English summary;
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md) — checklist before publishing to a community index;
- [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md), [`LICENSE`](LICENSE) (MIT).

## License

MIT. The bundled `runtime/vendor/qrcode-generator.cjs` is qrcode-generator 1.4.4 by Kazuhiko
Arase (MIT).
