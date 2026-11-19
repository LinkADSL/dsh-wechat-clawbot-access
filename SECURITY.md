# Security policy

## Reporting

Please report vulnerabilities privately to the maintainer, **LinkADSL**
(`lan_stone@foxmail.com`), instead of opening a public issue. Include the
affected version, a minimal reproduction, and the impact.

## Scope and threat model

This plugin exposes a WeChat-controlled bridge to the local DSH Web UI. It is
designed for a **single trusted owner** on a Windows + WSL2 host:

- The first unknown WeChat contact becomes a **pending** request; ownership must
  be approved in the authenticated DSH plugin page.
- The bot only sends the DSH token-bearing URL to the approved owner. Treat that
  URL as a password and do not forward it to others.
- DSH stays bound to `127.0.0.1:3080`; remote access is through SSH port
  forwarding. Never expose 3080 publicly or disable the SSH key-only policy.
- Bot tokens, reply contexts and the route secret are stored under
  `~/.dsh/wechat-clawbot` with `0700`/`0600` permissions and are never uploaded
  by this project.
- No telemetry is sent; the only outbound service is the Tencent WeChat iLink
  endpoint.

## Supported versions

Security fixes target the latest released `2.x` version. Older versions may
receive a best-effort fix; update before reporting if possible.
