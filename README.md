# DSH 微信 ClawBot 访问桥（DeepSeek Harness 插件 · v2.6 纯脚本版）

> **用途**：为了在手机上直接打开 DSH Web：在电脑上配置好 SSH 与端口转发后，
> 通过微信 ClawBot 获取 IPv6、token 等信息，即可在手机浏览器中打开 DSH 页面。

**仓库**：<https://github.com/LinkADSL/dsh-wechat-clawbot-access> · **包名**：`dsh-wechat-clawbot-access` · **许可证**：MIT

把 Harness 接到你的微信个人号：**网页里手动启动插件时弹出微信二维码，扫码确认登录 / 重新连接 bot**。
连上之后：

- 你在微信里给 bot 发任何东西，脚本立刻回复**当前 IPv6、SSH 端口/用户名、隧道命令**和**带 token 的 DSH 网页地址**；取不到就回一条明确的错误信息；
- 首次联系不会自动获得访问权：插件页确认绑定后，该微信号才成为 owner；
- 每天**下午 15:00** 自动通过 ClawBot 把同样的信息推送到你的微信；IPv6 变化时也会推送；
- 运行时是一个独立 Node 脚本（`runtime/clawbot.mjs`），**不经过 Agent、不创建会话、不消耗任何模型 token**；
- 无遥测、无第三方上报：除微信 iLink 通道外不访问外部服务，状态文件只留在本机 `~/.dsh/wechat-clawbot`。

官方通道：腾讯微信 ClawBot（iLink，`https://ilinkai.weixin.qq.com`）。

### 适用环境（先读）

- **Windows 10/11 + WSL2**（默认 NAT 网络）+ DSH Web + Node.js 20.3+（本机在 Node 24 / DSH 0.2.2-rc.5 测试）
- 需要一条**可入站的公网 IPv6**，并且光猫/路由器/Windows 三层都放行 TCP 22；
- 手机或外网设备需要安装支持端口转发的 SSH 客户端（Termius、Blink、JuiceSSH 等）；
- 不需要公网 IPv4、域名、DDNS；DSH 的 `3080` 不暴露公网，只通过 SSH 隧道访问。

> **中国家庭宽带的网络前置**（光猫 IPv6、路由器 IPv6 防火墙、运营商 CGNAT、WSL portproxy、
> Windows/第三方防火墙、VPN 干扰等）请先看 [docs/NETWORK.md](docs/NETWORK.md)；
> 这些问题不解决时，插件大概率能扫码登录、但手机连不上 SSH。

---

## 1. 架构（v2 相对 v1 的变化）

```
┌─────────────── DeepSeek Harness 进程 ───────────────┐
│  Host 插件 index.js（很薄）                          │
│   · 注册同源 JSON 路由 /wechat-clawbot/*              │
│   · 写出 dsh-web.json（当前进程的带 token 网页地址）    │
│   · spawn / 看护下方脚本，读取 status.json            │
│  Client 插件 client.js                               │
│   · 插件页控制面板 + shell.overlay 全屏扫码弹窗         │
└──────────────────────────┬───────────────────────────┘
                           │ spawn（detached，纯 Node）
┌──────────────────────────▼───────────────────────────┐
│  runtime/clawbot.mjs（纯脚本运行时）                   │
│   · iLink 扫码登录 → 长轮询 getupdates                │
│   · 收到消息 → runtime/access-info.mjs → 回复          │
│   · 内部定时器：每天 15:00 自动推送                      │
│   · 状态文件 status.json / state.json / 日志            │
└──────────────────────────────────────────────────────┘
```

v1 把每条微信消息交给一个 Agent Session 回复（消耗模型 token），且只有工具返回值里的二维码链接。
v2 删掉了 Session / Agent / 工具注册：所有微信逻辑都在脚本里完成，Host 只做 UI 与进程管理。

## 2. 安装 / 启动

[English README](README.en.md) · 插件目录：`<插件目录>`。

```bash
# 从本地目录安装（已安装时重复执行也是安全的）
# 在 Harness 会话里：
plugin_manager install_bundle target=<插件目录>
# 如果已安装但被禁用，则启用 bundle（target 用 package.json 里的 name）：
plugin_manager set_bundle target=<package.json 的 name> enabled=true

# 发布到 npm/社区索引后（示例，替换成实际 scope/版本）：
plugin_manager install_bundle target=dsh-wechat-clawbot-access@2.6.0

# 本包已配置公开包名 dsh-wechat-clawbot-access 与仓库 LinkADSL/dsh-wechat-clawbot-access；
# 发布前只需 npm login 后执行 npm publish；完整清单见 docs/PUBLISHING.md。
```

启用后：

1. 打开 **设置 → 插件 → DSH 微信 ClawBot 访问桥**；
2. 运行时自动启动（`autoStart: true`），网页会**自动弹出全屏微信二维码**（若还没登录 / 需要重新登录）；
3. 用手机微信扫码，并在手机上确认连接；
4. 状态变为「已连接」后，弹窗自动关闭。
5. **请在微信里先给 bot 发一条消息**（任意文字/表情）。首次使用会进入**待确认绑定**：
   bot 回复一条“等待 DSH 插件页确认”的提示；回到插件页 STATUS →「待确认绑定」点「允许绑定」后，
   该微信号才成为 owner。之后的回复（以及 IPv6 变化/每日 15:00 推送）包含：
   时间戳、IPv6、SSH 端口/用户名、`ssh -N -L ...` 隧道命令、带 token 的完整链接。
   这条消息同时为微信协议保存“回复上下文”，之后 15:00 的每日推送才有可用的发送凭据。
   也可以提前在 `cordis.patch.yml` 配置 `allowedUsers` 白名单（受信任联系人首次消息即可成为 owner）。

> **首次使用/更新后请刷新一次网页**：二维码弹窗与控制面板是 Client 插件，插件升级后浏览器需要刷新
> 才能加载新版本。插件路由使用一个只注入到已登录页面里的密钥做校验：该密钥持久化在
> `~/.dsh/wechat-clawbot/route-secret`（0600），插件热重载/DSH 重启都不会失效；即使页面里的密钥过期，
> 新版 Client 也会自动从 `/` 重新读取并重试，正常情况下无需手动刷新。
>
> v1 升级到 v2 后**第一次启动会强制弹码**（旧 token 没有 v2 的扫码确认记录），重新扫码一次即可；
> 之后只要 token 未过期（`reuseTokenDays`，默认 30 天）且会话有效，DSH 重启不会重复要求扫码。
> iLink 会话失效（`session timeout`）时，脚本会自动重新生成二维码，网页弹窗会再次出现。
>
> 等待扫码期间二维码过期会**自动换新码**（最多 12 次，约 1 小时）；若超过后仍未扫码，
> 插件页状态显示「需要登录」，点「重新扫码登录」即可继续。

### 插件页按钮

| 按钮 | 作用 |
| --- | --- |
| 启动运行时 | 拉起脚本（若已在运行则无事发生） |
| 停止运行时 | 让脚本优雅退出（状态文件/日志保留） |
| 重新扫码登录 | 强制生成新二维码（弹窗立即出现） |
| 立即发送信息 | 立刻把最新 IPv6 + 带 token 地址推送到已绑定微信 |
| 获取访问信息 | 只在本页面预览（不发送） |
| 检测 IPv6 | 手动触发一次 IPv6 变化检测（有变化才推送） |
| 允许绑定 / 拒绝绑定 | 处理「待确认绑定」中的微信联系人；允许后才可收到访问信息 |
| 退出登录 / 解除绑定 | 清除 bot token，或清除微信绑定，下一条消息重新申请绑定 |

## 3. 脚本

所有脚本都可以脱离 Harness 单独运行（纯 Node，无 npm 依赖）：

```bash
cd <插件目录>

# ① 获取 IPv6 + 带 token 的 DSH 网页地址（人读 / JSON / 退出码）
node runtime/access-info.mjs
node runtime/access-info.mjs --json
node runtime/access-info.mjs --no-windows     # 不调用 Windows PowerShell（强制 WSL 检测）

# ② 守护运行时（扫码、自动回复、每天 15:00 推送）
node runtime/clawbot.mjs
node runtime/clawbot.mjs status               # 打印 daemon 状态 + 最新访问信息（JSON）
node runtime/clawbot.mjs push                 # 立即发送一次（等价插件页「立即发送信息」）
node runtime/clawbot.mjs qr                   # 只申请一个二维码并在终端打印（ASCII）

# ③ 常用参数
node runtime/clawbot.mjs --state-dir ~/.dsh/wechat-clawbot \
  --push-hour 15 --push-minute 0 --reuse-token-days 30 --log-level info

# ④ 测试与静态检查（无第三方依赖）
npm test
npm run check
```

`access-info.mjs` 的信息来源与规则：

1. **IPv6**：先查 WSL 自身（`ip -6` 全局地址）；WSL 是 NAT 模式没有全局 IPv6 时，通过
   `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` 读取 **Windows 主机**的 IPv6，
   优先取稳定地址（SuffixOrigin=Link/Dhcp），排除 `fe80::` 与隐私临时地址。两者都没有 → 报错。
2. **DSH 带 token 网页地址**：
   - 优先读 Host 插件写出的 `~/.dsh/wechat-clawbot/dsh-web.json`（含当前进程的 token，最快最准）；
   - 其次从 `journalctl --user` 的 `dsh web: http://...?token=...` 启动行提取，并校验端口当前确实在监听；
   - 都没有 → 报错。
3. **SSH 隧道提示**（warning，不影响信息采集）：
   - Windows 未把 IPv6 的 SSH（`sshPort`，默认 22）转发到 WSL（`ssh-portproxy-missing`）；
   - 转发仍指向旧 WSL IPv4（`ssh-portproxy-stale`，WSL 重启后常见），消息里会附管理员修复命令；
   - 读不到 sshd 主机公钥时提示 `ssh-hostkey-missing`。
   这些提示会显示在插件页，也以短句附在微信回复里（见下文）。

### 微信里收到的内容示例

成功（v2.3 极简格式；DSH 不再直接暴露 3080，链接经 SSH 隧道使用）：

```
🕒 2026-11-19 17:40
IPv6：240e:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx
SSH：端口 22，用户名 <你的用户名>
隧道：ssh -N -L 3080:127.0.0.1:3080 -p 22 <WSL用户名>@[240e:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx]
链接：http://127.0.0.1:3080/?token=…
```

失败（例如拿不到 IPv6 或 token）：

```
⚠️ DSH 信息获取失败：未检测到全局 IPv6
🕒 2026-11-19 17:40
（能获取到的字段会继续列出）
```

### 状态 / 数据文件（`~/.dsh/wechat-clawbot/`，目录 0700）

| 文件 | 说明 |
| --- | --- |
| `state.json` | bot token、同步游标、已绑定联系人、回复上下文、IPv6 监控基线；0600，自动从 v1 迁移 |
| `status.json` | daemon 实时状态（阶段、二维码矩阵、推送时间、统计、日志路径）；0600 |
| `dsh-web.json` | 当前 DSH 进程的带 token 网页地址快照；0600，Host 启动/每分钟刷新 |
| `commands/` | Host 写给 daemon 的控制指令（JSON 小文件） |
| `logs/clawbot.log` | 运行日志（超过 2 MiB 轮转，保留 `.1`/`.2`/`.3`） |
| `route-secret` | 自定义路由密钥（0600；Host 无法注入密钥时路由直接禁用） |

### 每天 15:00 的调度

定时器在 `runtime/clawbot.mjs` 内部（本机时区，默认 15:00，可由 `pushHour` / `pushMinute` 调整）。
只要 DSH 在运行（`dsh-web.service` 默认开机自启），运行时就会常驻并按时推送。
如果希望 DSH 停机时也常驻，可把脚本单独做成 systemd 用户服务（示例）：

```ini
# ~/.config/systemd/user/wechat-clawbot.service
[Unit]
Description=WeChat ClawBot pure-script runtime
After=network-online.target

[Service]
WorkingDirectory=/path/to/wechat-clawbot
ExecStart=/usr/bin/env node runtime/clawbot.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

> 注意：同一 bot token 同时只允许一个长轮询客户端。用 systemd 单独常驻时，请把插件配置的
> `autoStart` 设为 `false`，避免两条实例互相抢占。

### 每小时 IPv6 变化监控（v2.1 新增）

运行时每小时在**本机**探测一次 IPv6；只有当地址**真的发生变化**时，才通过 bot 推送最新信息
（成功发送前失败会标记 pending，等微信回复上下文可用后自动重试）：

```
🔁 自动监控：电脑 IPv6 已更新
🕒 2026-11-19 18:00
IPv6：240e:...:b22c
SSH：端口 22，用户名 <你的用户名>
隧道：ssh -N -L 3080:127.0.0.1:3080 -p 22 <WSL用户名>@[240e:...:b22c]
链接：http://127.0.0.1:3080/?token=…
```

如果检测到 IPv6 消失，会推送一条 `⚠️ 自动监控：电脑全局 IPv6 已丢失` 的错误提示。
间隔由 `ipv6WatchMinutes` 控制（默认 60，0 = 关闭）；插件页「检测 IPv6」可手动触发一次变化检测。

**性能设计（为什么不需要 C/C++）** —— 实测（本机）：

| 阶段 | 实现 | 实测开销 | 触发频率 |
| --- | --- | --- | --- |
| WSL 自身有全局 IPv6 | 直接读 `/proc/net/if_inet6`（纯 JS，零子进程） | **~1 ms** | 每小时 |
| WSL NAT 模式（当前本机） | `netsh interface ipv6 show addresses`，只提取 IPv6 字面量（与系统语言无关） | **~80 ms** | 每小时 |
| 稳定地址可能变化 / 首次 | PowerShell `Get-NetIPAddress` 解析稳定地址 | ~1.1 s | 仅当候选地址集变化或首次 |
| 地址确实变化 | 完整信息采集（token/journal）+ 微信发送 | ~1.5–2 s | 仅变化时 |

即日常每小时开销约 **80 ms 的进程启动等待**（CPU 占用接近 0），一天不到 2 秒；
完整采集与发送只在地址真正变化时发生一次。用 C/C++ 写 helper 无法改善：Windows 路径的成本是
WSL→Windows 的进程互操作固定开销（连 `cmd.exe /c echo` 都要 ~60 ms），而 Linux 侧 C helper
只能省掉 /proc 读取的约 1 ms，收益可以忽略，却会引入编译产物和跨平台维护成本，所以保持纯脚本实现。

## 4. 手机/电脑通过 SSH 隧道访问 DSH（v2.2 起）

**DSH 不再对网络开放**：直接访问 3080 的公网转发和防火墙规则已移除，DSH 只监听
`127.0.0.1:3080`。手机/电脑先建立 SSH 本地端口转发（本地 3080 → DSH 的 127.0.0.1:3080），
再打开 bot 发来的 `http://127.0.0.1:3080/?token=...`。这样 token 与浏览器会话都在 SSH 加密通道里。

### 服务端需要完成的配置（通用步骤）

以下配置不依赖本机现状，换一台 Windows + WSL2 机器也需要做：

1. WSL 内安装/启用 `openssh-server`，确认 `ssh.socket`/sshd 监听 22；仅允许密钥登录
   （`PasswordAuthentication no`），建议加 `AllowUsers <你的用户>`、`PermitRootLogin no`、
   `X11Forwarding no`；
2. Windows 管理员 PowerShell 添加 22 的端口转发（把 `<WSL_IP>` 换成 `wsl hostname -I` 的结果）：

   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=22 connectaddress=<WSL_IP> connectport=22
   netsh interface portproxy add v6tov4 listenaddress=:: listenport=22 connectaddress=<WSL_IP> connectport=22
   ```

   WSL 重启后 IP 可能变化，运行 `scripts/refresh-wsl-portproxy.ps1` 或执行插件回复里的修复命令；
3. Windows 防火墙入站放行 TCP 22（规则 `dsh_ssh_22`），并检查 360/火绒等安全软件；
4. **光猫/路由器 IPv6 防火墙**放行 WAN→LAN 的 TCP 22；IPv6 无 NAT、端口映射不适用；
5. DSH 只监听 `127.0.0.1:3080`；不要为 3080 做公网转发。桌面访问所需的
   Windows→WSL 3080 转发只用于本机，不要暴露到公网；
6. 如果旧版文档让你给 DSH 加过 IPv6 的 `--trusted-host`，现在可以移除（隧道访问 Host 是
   `127.0.0.1`）；但移除后需要重启 dsh-web 才生效。

### 中国家庭宽带常见坑

- **IPv6 未开启**：光猫/路由器需要开启 IPv6、DHCPv6/SLAAC，并给局域网下发前缀；否则 Windows 上
  没有 `240e/2408/2409` 开头的公网地址，插件只能报错。
- **光猫/路由器 IPv6 防火墙默认拒绝入站**：这是“手机 timeout”的首要原因；需要在设备里放行 22，
  而不是关掉整台设备的防火墙。
- **IPv6 前缀会变**：光猫/路由器重启、运营商维护后地址可能变化；插件每小时推送新地址，
  手机上的旧 SSH 地址需要换成 bot 最新消息里的。
- **光猫桥接 vs 路由**：桥接由路由器拨号时，IPv6 防火墙在路由器配置；两层 NAT/两层 IPv6 防火墙
  容易互相打架。
- **CGNAT**：中国宽带 IPv4 常无独立公网地址，IPv4 端口映射通常不可用；本插件选择 IPv6 直连。
- **22 端口/运营商限制**：少数地区会限制 IPv6 入站或特定端口；若确认被限制，改用
  Tailscale/WireGuard/Cloudflare Tunnel，而不是关闭光猫防火墙。
- **VPN/代理干扰**：某些 TAP/TUN VPN/代理/加速器可能改写路由/DNS/防火墙，导致 IPv6 或 portproxy 失效；
  测试时先退出。
- **WSL 重启换 IP**：portproxy 还指着旧地址 → “昨天能连今天不能”；运行刷新脚本即可。

完整清单和排错表见 [docs/NETWORK.md](docs/NETWORK.md)。

### 手机需要做什么

1. 安装支持 SSH 端口转发的客户端：**Termius**（iOS/Android）、**Blink Shell**（iOS）或 **JuiceSSH**（Android）；
2. 新建 SSH Host：
   - Host / Address：`240e:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx`（以 bot 每条消息里的 IPv6 为准）
   - Port：`22`
   - Username：`<你的用户名>`
   - Auth：生成的 **ED25519 密钥**（私钥留在手机；首次连接会显示主机指纹，核对插件页「主机指纹」
     一栏的 `SHA256:...`）
3. 把手机公钥加入 WSL 的 `~/.ssh/authorized_keys`（在电脑的 WSL 终端或已有 SSH 会话中执行）：
   `echo 'ssh-ed25519 AAAA... you@phone' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
4. 在该 SSH Host 上配置 **本地端口转发（Local Port Forward）**：
   `127.0.0.1:3080 → 127.0.0.1:3080`（Termius: Port Forwarding → Local → 3080/127.0.0.1/3080）；
5. 连接 SSH 后，用手机浏览器打开 bot 消息里的 `http://127.0.0.1:3080/?token=...`。

### 电脑需要做什么

- 日常桌面访问不需要任何改动：仍是 `http://127.0.0.1:3080`；
- 在外网/离开本机时（可选）：`ssh -N -L 3080:127.0.0.1:3080 -p 22 <WSL用户名>@[IPv6]`
  （bot 消息里有可直接复制的完整命令），然后浏览器打开 bot 给出的
  `http://127.0.0.1:3080/?token=...`。

### WSL / Windows 重启后的注意事项

Windows 端口转发里记录了 WSL 的 IPv4 地址，而 WSL 重启后该地址可能变化。插件每次采集都会核对：
若发现转发仍指向旧地址，会在**微信回复里**给出管理员 PowerShell 修复命令（含当前 WSL IP），
例如：

```powershell
netsh interface portproxy set v4tov4 listenport=22 listenaddress=0.0.0.0 connectport=22 connectaddress=<当前WSL IPv4>
netsh interface portproxy set v6tov4 listenport=22 listenaddress=:: connectport=22 connectaddress=<当前WSL IPv4>
```

复制执行一次即可（Windows 防火墙规则 `dsh_ssh_22` 不受影响）。也可以直接用插件附带的脚本
（管理员 PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\refresh-wsl-portproxy.ps1
```

### 安全说明

- 公网侧只暴露 **SSH（22）**，且仅允许密钥登录；DSH 的 token/网页不再直接暴露在公网 IPv6；
- bot 分发的都是**公开信息**（IPv6、主机公钥指纹、localhost token URL）——公钥/指纹可以安全经微信传输，
  **私钥绝不要发到微信**；
- 手机 SSH 私钥建议设置口令/生物识别保护；如手机丢失，从 `~/.ssh/authorized_keys` 删除对应公钥即可；
- 如需更彻底地关闭公网端口，可改用 Tailscale/WireGuard 方案（不开任何入站端口，但需安装客户端）。

## 5. 配置（`cordis.patch.yml` 的 bundle `config`）

```yaml
- id: wechat-clawbot
  config:
    autoStart: true          # 启用插件即启动运行时
    pushEnabled: true
    pushHour: 15             # 每天 15:00 自动推送
    pushMinute: 0
    sshPort: 22              # SSH 端口；非标端口需同步修改 sshd/portproxy/防火墙/刷新脚本
    reuseTokenDays: 30       # 扫码确认后 token 复用天数；超期重新扫码
    maxSendChars: 1800       # 单条微信消息上限
    logLevel: info
    # stateDir: ~/.dsh/wechat-clawbot
    # allowedUsers: ['wxid_xxx']   # 留空 = 首个联系人进入待确认绑定，需在插件页允许
```

## 6. 安全

- 回复里包含 **DSH 登录 token**（等价于登录凭证），只发给经过插件页确认的 owner；
  其他联系人只会收到「待确认绑定」或「未绑定」提示，不会看到任何地址。
- **首次联系人不会自动成为 owner**：先进入 `pendingOwner` 待确认状态，必须在插件页点「允许绑定」；
  可随时「解除绑定」，之后新联系人重新走确认流程。
- 想更严格就配置 `allowedUsers` 白名单（白名单内联系人受信任，首次消息即可成为 owner）。
- 自动拒绝/配对提示有 10 分钟 30 条的上限，避免被陌生账号当作自动回复机滥用。
- `state.json` / `status.json` / `dsh-web.json` / `route-secret` 均 0600，目录 0700；
  日志中的联系方式默认脱敏，消息正文仅在 `logLevel=debug` 时记录。
- 二维码是本地按 `qrcode_img_content` 链接渲染的 SVG，不含第三方图片服务。
- `/wechat-clawbot/*` 自定义路由不在 Harness 浏览器鉴权范围内：Host 把随机密钥通过
  `webServer.tapIndex` 只注入到**已登录页面 HTML** 中，客户端每次请求都带上；密钥不匹配返回 403。
  如果 Host 无法注入密钥（旧版/异常环境），路由直接返回 503（fail closed），不会退化成可预测密钥。
- 状态写盘：**没有周期心跳**；只在启动/停止和真实事件（阶段变化/消息/推送/绑定）时写
  `status.json`。`heartbeatAt` 表示最近一次状态持久化时间；进程存活由 Host 用 PID 判断。

## 7. 故障排查

```bash
# 运行时是否活着、当前阶段、token 是否有效
node runtime/clawbot.mjs status

# 最近日志
tail -n 100 ~/.dsh/wechat-clawbot/logs/clawbot.log
journalctl --user -u dsh-web.service -n 100 --no-pager

# 手动验证信息采集
node runtime/access-info.mjs --json

# 手动触发一次推送（不经过网页）
node runtime/clawbot.mjs push
```

- **二维码弹窗没出现**：确认 bundle 已启用、Client 插件已加载（升级 client.js 后需要刷新一次网页）；
  或直接看插件页状态，点「重新扫码登录」。
- **微信回复报错**：多数是拿不到 IPv6 或 token，`access-info.mjs --json` 的 `errors`/`warnings` 会写清楚原因。
- **长时间无响应**：看 `status.json` 的 `phase`；`login-needed` = 需要扫码，`polling` = 正常监听。
- **IPv6 监控提示 pending**：表示检测到变化但当时无法发送（未登录/没有回复上下文/网络失败），
  插件会在收到下一条微信消息或下次检测时自动重试。
- **有绑定请求但没收到信息**：打开插件页，STATUS 里看「待确认绑定」，点「允许绑定」。
- **推送显示 pending**：`status.json` 的 `pendingPush` 非空表示上次投递失败，运行时会在
  5 分钟起指数退避重试（最多 8 次），收到新消息或重启也会补试。
- **测试失败**：在插件目录执行 `npm test` / `npm run check`；CI 见 `.github/workflows/ci.yml`。
- **token 泄露风险**：在 Harness 里重启 dsh-web（token 会变）并在微信侧保守使用；或插件页退出登录后重扫。

## 8. 兼容性与已知限制

- 已在 **DSH 0.2.2-rc.5 + Node 24 + Windows 11 + WSL2 (Ubuntu)** 上验证；Node 下限 20.3（使用了
  `AbortSignal.any`）。
- 仅支持 **Windows + WSL2**；macOS/Linux 需要自行替换 IPv6 检测与 portproxy 部分。
- 需要可入站的公网 IPv6；没有 IPv6 入站/CGNAT 用户请使用 Tailscale/WireGuard/Cloudflare Tunnel。
- SSH 端口可通过 `sshPort` 配置（默认 22）；改成非标端口时，需要同时修改 sshd、portproxy、防火墙和
  `scripts/refresh-wsl-portproxy.ps1 -SshPort`。
- 配置已导出 `Config` schema，可在插件管理页修改（同时仍可直接编辑 `cordis.patch.yml`）；
  状态/日志在 `~/.dsh/wechat-clawbot/`。
- 已配置公开包名 **`dsh-wechat-clawbot-access`**、GitHub 仓库
  **`LinkADSL/dsh-wechat-clawbot-access`** 和 MIT 许可证；尚未执行 `npm publish`（需要先 `npm login`）。
  发布清单见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 9. 许可证与致谢

MIT，见 [LICENSE](LICENSE)；内置的 `runtime/vendor/qrcode-generator.cjs` 为 Kazuhiko Arase 的
qrcode-generator 1.4.4（MIT）。微信 ClawBot 通道为腾讯 iLink 私有协议，本项目仅做协议客户端实现。

## 10. 版本记录

v2.3 的安全/可靠性改动见仓库根目录 `CHANGELOG.md`：待确认绑定、路由 fail-closed、日志脱敏与拒绝限流、
移除周期心跳、推送失败补偿重试、日志多份轮转、单元测试/CI、docs 详情页与许可证。

v2 重写覆盖了旧版 `index.js` / `client.js` / `README.md` / locale，删除了旧的 Session-Agent 桥接逻辑与
工具注册；旧版 `state.json` 由脚本自动迁移为 v2 结构（保留绑定联系人/回复上下文，token 因需要重新扫码
确认登录而清空），旧字段（`options`、`sessionId`、`typingTicket` 等）已随迁移删除。

本次交付还清理了开发期临时产物：`/tmp` 下的二维码/PNG 自检脚本与图片、debug 状态目录、临时备份、
浏览器 cookie/抓取文件、会话扫描脚本，以及旧 v1 安装过程留下的 pnpm 操作日志（Harness 自身的
plugin-manager 目录只保留近期记录）。插件目录现在只包含运行必需的源码、locale、图标、脚本与 README：

```
index.js  client.js  package.json  cordis.patch.yml  icon.svg  README.md
locale/{zh,en}.json
runtime/{clawbot,common,access-info,qr}.mjs
runtime/vendor/qrcode-generator.cjs    # MIT, Kazuhiko Arase
```
