![微信手机通过二维码登录与 SSH 隧道连接到本机 DSH 面板](preview.svg)

# DSH 微信 ClawBot 访问桥

一个纯脚本桥：把个人微信号变成 **DeepSeek Harness（DSH）** 的安全远程访问助手。
DSH 始终只监听 `127.0.0.1:3080`；手机通过 SSH 本地端口转发访问它，微信 ClawBot
（iLink）聊天负责下发当前的 IPv6、SSH 端点和带 token 的 localhost 地址。

运行时是一个独立 Node.js 脚本，**不创建 Agent、不创建会话、不调用模型，也不消耗
任何 LLM token**。

## 功能

- 插件启动时在 DSH 面板里显示微信登录二维码；
- 第一个陌生联系人只进入「待确认绑定」，必须在插件页批准后才发送访问信息；
- 已绑定 owner 每次发微信，都会收到：
  - 当前公网 IPv6（取不到时给出明确错误）；
  - SSH 端口、用户名、主机密钥指纹和可直接复制的隧道命令；
  - 当前 `http://127.0.0.1:3080/?token=…` 地址；
- 每天 **15:00** 和 IPv6 地址变化时自动推送同样信息；
- 状态/日志写在 `~/.dsh/wechat-clawbot/`，使用原子写入、单实例锁和可重试推送。

## 工作方式

```text
┌─────────────┐   微信 / iLink     ┌─────────────────┐
│ 手机微信    │◄──────────────────►│ 微信 ClawBot    │
│             │                    │ (iLink 服务)    │
└──────┬──────┘                    └────────┬────────┘
       │ SSH 本地端口转发                  │ 长轮询 / 发送
       ▼                                   ▼
┌──────────────────────────────────────────────────────┐
│ Windows 11 + WSL2 主机                               │
│                                                      │
│  sshd ◄── SSH 隧道 ── 手机                           │
│    │                                                 │
│    └── 127.0.0.1:3080  DSH Web UI                    │
│                                                      │
│  DSH Host 插件 ── 拉起/看护 ──► 运行时脚本           │
│     │  面板、二维码、owner 确认、Config schema        │
│     └── 访问信息：IPv6 + SSH + DSH token URL         │
└──────────────────────────────────────────────────────┘
```

## 安全模型

- **只通过 SSH 访问**：DSH 不暴露公网端口；手机建立 SSH 本地转发后访问
  `127.0.0.1` 地址。
- **owner 批准**：陌生微信只进入待确认状态；未在插件页批准前不发送任何访问信息。
- **最小化共享**：token URL 只发给已批准的 owner；该 URL 本身是秘密，不应转发。
- **本地状态**：bot token、回复上下文、route secret 只保存在
  `~/.dsh/wechat-clawbot/`，权限受限；无遥测、无第三方上报。
- **不经过模型**：运行时不 import Harness 包，也不调用 LLM。

完整威胁模型和漏洞报告方式见 [`SECURITY.md`](../SECURITY.md)。

## 环境要求

- Windows 10/11 + **WSL2**（推荐 Ubuntu）和 DSH Web；
- Node.js **20.3+**；
- **可入站的公网 IPv6**，并在光猫、路由器、Windows 防火墙和 WSL `sshd` 放行
  SSH 端口（默认 22）；
- 手机安装支持端口转发的 SSH 客户端（Termius、Blink、JuiceSSH 等）；
- 不需要公网 IPv4、域名或 DDNS。

> IPv6/CGNAT/portproxy 是最常见的失败点。扫码能登录但手机连不上时，先读
> [`NETWORK.md`](NETWORK.md)。

## 安装

从本地目录：

```sh
dsh plugin --profile web add /path/to/dsh-wechat-clawbot-access
```

或从 GitHub（社区条目）：

```sh
dsh plugin --profile web add https://github.com/LinkADSL/dsh-wechat-clawbot-access
```

然后打开 **设置 → 插件 → DSH 微信 ClawBot 访问桥**，启动运行时，用准备作为
owner 的手机微信扫码。

## 配置

插件导出经过校验的 `Config` schema；可在插件管理页修改，也可直接编辑
`cordis.patch.yml`。

| 配置 | 默认值 | 说明 |
|---|---|---|
| `autoStart` | `true` | 插件加载时自动启动运行时 |
| `pushEnabled` | `true` | 每日推送访问信息 |
| `pushHour` / `pushMinute` | `15:00` | 本地时间推送时刻 |
| `ipv6WatchMinutes` | `60` | IPv6 变化检测间隔（`0` 关闭） |
| `sshPort` | `22` | 隧道命令和 portproxy 检测使用的 SSH 端口 |
| `maxSendChars` | `1800` | 单条微信消息最大字符数 |
| `reuseTokenDays` | `30` | 已确认 bot token 的复用天数 |
| `allowedUsers` | `[]` | 可选白名单；留空启用待确认绑定流程 |

## 性能

- 正常回复路径只做一次访问信息采集并格式化；
- daemon 启动时**预热**一次 IPv6/SSH/token，后续复用稳定 IPv6 快速路径和 SSH
  主机密钥缓存；
- 开发机实测：冷启动首次采集约 **1.5–1.8 秒**，热路径约 **0.2 秒**；
- IPv6 watcher 使用 `/proc` + `netsh`，只有稳定地址变化时才调用 PowerShell。

## 限制

- 仅支持 Windows + WSL2；Linux/macOS 需要另写 IPv6/portproxy provider。
- 手机侧 SSH 隧道需要可入站 IPv6；CGNAT 用户建议改用
  Tailscale/WireGuard/Cloudflare Tunnel。
- DSH token URL 是 bearer secret；泄露后应重启 DSH 轮换 token，必要时重新扫码。
- 本插件定位是轻量远程访问助手，不是通用微信聊天机器人。

## 更多文档

- [主 README](../README.md)
- [网络排障](NETWORK.md)
- [社区上架清单](PUBLISHING.md)
- [安全策略](../SECURITY.md)
