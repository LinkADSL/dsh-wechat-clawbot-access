# 中国家庭宽带 IPv6 + SSH 访问网络配置指南

本插件解决的是“手机/外网通过 SSH 隧道访问家里 DSH 网页”，不是云服务。它能否用起来，取决于
**光猫/路由器 → Windows 防火墙 → WSL → sshd → DSH** 这条链路上的每一个环节。本文针对中国家庭宽带
（电信/联通/移动，光猫 + 无线路由器，Windows + WSL2）整理常见坑。

> 术语：本文的“公网 IPv6”指 `240e::/20`、`2408::/20`、`2409::/20` 等运营商下发的全球单播地址，
> 不是 `fe80::` 链路本地地址，也不是 `fd00::/8` 内网地址。

## 1. 先确认你是否有可用的公网 IPv6

```powershell
# Windows：查看 WLAN/以太网的 IPv6 地址
ipconfig
netsh interface ipv6 show addresses
```

- 应看到以 `240e`、`2408`、`2409` 等开头的地址；`240e...` 是常见电信前缀。
- 如果只有 `fe80::` / `fd00::`，说明光猫或路由器没有开启 IPv6，或运营商没有下发 IPv6。
- 手机用**蜂窝数据**（关掉家里 WiFi）打开 <https://test-ipv6.com>，确认手机本身有 IPv6。
  很多“家里能连、出门连不上”的问题，其实是手机当前网络没有 IPv6。

**为什么强调 IPv6**：中国家庭宽带常见 CGNAT，IPv4 没有独立公网地址，做端口映射往往不可用；IPv6 通常
每个设备一个公网地址，才适合 SSH 直连。

## 2. 光猫配置（最容易卡住的一层）

不同省份、运营商、光猫型号（天翼/华为/中兴/烽火等）菜单不同，下面给通用检查项，以运营商 App 或
装机师傅提供的管理入口为准；不要照搬网上的“超级密码”，也不要在不了解后果时改桥接。

1. **IPv6 开关**
   - 光猫 WAN 连接里开启 IPv6（常见名称：IPv6 使能、IPv4/IPv6 双栈、DHCPv6、SLAAC、Prefix Delegation）。
   - 部分地区默认关闭 IPv6，需要联系运营商开通；可以先问客服“我家宽带是否支持 IPv6、光猫是否已开启”。
2. **IPv6 防火墙（关键）**
   - 光猫或路由器通常有“IPv6 防火墙”开关/安全等级。IPv6 不做 NAT，**没有端口映射**；要让外部访问
     TCP 22，必须在防火墙里放行入站，或把防火墙调低/关闭（不推荐全局关闭）。
   - 如果设备只提供“开/关”而没有自定义规则：
     - 更安全的做法是让光猫桥接、由路由器拨号并按设备/端口配置 IPv6 防火墙；
     - 至少要意识到“关闭 IPv6 防火墙”会把家里所有 IPv6 设备暴露在公网，只应在明确知道风险时短期使用。
   - 若光猫是路由模式，某些型号的 IPv6 防火墙只允许内网互访，必须找到“IPv6 入站/安全策略”并放行
     Windows 的 IPv6 地址（或按 IPv6 后缀/EUI-64 识别设备）。
3. **桥接 vs 路由**
   - 光猫桥接 + 路由器 PPPoE 拨号：IPv6 前缀由路由器获取并下发，防火墙在路由器配置。
   - 光猫路由 + 路由器二级路由：容易出现两层 IPv6 防火墙/前缀问题，尽量只保留一层路由，或确认两级都放行。
4. **前缀会变**
   - 光猫/路由器重启、断电、运营商维护、PPPoE 重拨后，IPv6 前缀可能变化。插件每小时检测并推送新地址；
     但手机上的 SSH 客户端如果保存了旧地址，需要换成 bot 最新消息里的地址。
5. **运营商限制**
   - 少数地区/套餐会限制 IPv6 入站，或对 80/443/25 等端口有策略；22 一般可用但不保证。
   - 如果确认 IPv6 入站被运营商封锁，改用 Tailscale / WireGuard / Cloudflare Tunnel 等覆盖网络，
     不要继续折腾端口映射。

## 3. 路由器配置（光猫桥接时）

1. 路由器 WAN 设置为 PPPoE（或 DHCPv6），开启 IPv6，获取运营商前缀。
2. 局域网开启 IPv6 地址下发（SLAAC/DHCPv6）。
3. **IPv6 防火墙**：允许 WAN 侧入站 TCP 22 到运行 DSH 的 Windows 主机；能按设备/IPv6 后缀限制最好。
4. 不建议对整台 Windows 主机开 DMZ；只放行 22。
5. 某些路由器默认“IPv6 防火墙”阻止所有入站，需要在“安全/防火墙/端口过滤”里加规则。

## 4. Windows 防火墙与第三方安全软件

```powershell
# 管理员 PowerShell：放行 TCP 22 入站（与插件脚本 dsh_ssh_22 一致）
netsh advfirewall firewall add rule name="dsh_ssh_22" dir=in action=allow protocol=TCP localport=22 profile=any
```

- 检查 Windows 防火墙服务、IP Helper（`iphlpsvc`）是否运行；`netsh interface portproxy` 依赖 IP Helper。
- 网络配置文件（专用/公用/域）会影响默认策略；规则写成 `profile=any` 最省事，但公用网络下仍建议保持
  密钥登录，不要用密码。
- **360 安全卫士、火绒、腾讯电脑管家**等有自己的网络防火墙，可能在 Windows 防火墙之外再拦一次；
  需要在对应软件里放行 22，或临时退出测试。
- 如果 Windows 上同时开着 VPN/代理（包括 某些 TAP/TUN VPN/代理/加速器 TAP/TUN 软件），它们可能改写
  默认路由、DNS、防火墙；IPv6 直连可能被破坏。测试时先退出 VPN/代理，或设置分流/绕过 22 端口。
- 不要在公网暴露 `3080`：本插件只让 DSH 监听 `127.0.0.1:3080`，对外只开 22。

## 5. WSL2 与 Windows portproxy

默认 WSL2 是 NAT 网络：WSL 内没有公网 IPv6，Windows 端用 `netsh interface portproxy` 把 22 转发进 WSL。
这是**Windows 到 WSL** 的转发，不是公网入口；公网入口仍由光猫/路由器的 IPv6 防火墙决定。

```powershell
# 管理员 PowerShell，<WSL_IP> 用 wsl hostname -I 查看
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=22 connectaddress=<WSL_IP> connectport=22
netsh interface portproxy add v6tov4 listenaddress=:: listenport=22 connectaddress=<WSL_IP> connectport=22
```

- **WSL IP 会变**：`wsl --shutdown`、Windows 重启、WSL 更新后都可能变化，旧 portproxy 指向旧 IP 就会
  “SSH 突然连不上”。本插件会在微信回复里检测并给出修复命令，也可运行
  `scripts/refresh-wsl-portproxy.ps1`（管理员）。
- `netsh` 转发规则写注册表、重启后仍在，但里面记录的 WSL IP 可能已过期。
- `localhostForwarding` 对“WSL 内只监听 127.0.0.1 的服务”并不可靠；桌面访问 DSH 的 3080 也依赖
  Windows→WSL 的 portproxy（只用于本机/局域网，不要暴露公网）。
- Windows 11 22H2+ 可尝试 WSL mirrored networking（`.wslconfig` 里 `networkingMode=mirrored`），
  行为与 NAT 不同；启用后需要重新验证 sshd/DSH 监听和防火墙，插件默认按 NAT 环境设计。
- sshd 在 WSL 里由 systemd socket 激活、仅密钥登录；修改 `sshd_config` 后不需要重启整个 Windows，
  但需要确保 `ssh.socket` 在运行。

## 6. 手机/外网验证顺序

1. 手机用**蜂窝数据**（不要连家里 WiFi）打开 `https://test-ipv6.com`，确认有 IPv6。
2. 在手机 SSH 客户端（Termius/Blink/JuiceSSH）填：Host = 公网 IPv6（**不要带方括号**）、Port = 22、
   Username = WSL 用户名、认证 = 私钥。
3. 如果 **timeout**：通常是光猫/路由器 IPv6 防火墙、运营商入站限制、手机无 IPv6。
4. 如果 **Connection refused**：说明网络到了 Windows，但 22 没有监听/portproxy 不对/Windows 防火墙拦；
   在 Windows 上检查 `Test-NetConnection <IPv6> -Port 22`、`netsh interface portproxy show all`。
5. SSH 登录成功后配置本地转发 `3080 → 127.0.0.1:3080`，打开 bot 消息里的
   `http://127.0.0.1:3080/?token=...`。
6. 换网络（家里 WiFi ↔ 蜂窝）测试，确认是“公网 IPv6 入站”而不是“局域网恰好能通”。

## 7. 常见错误对照表

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| bot 发的 IPv6 手机连不上（timeout） | 光猫/路由器 IPv6 防火墙未放行 22；运营商限制；手机无 IPv6 | 先在光猫/路由器放行 TCP 22；手机用蜂窝验证 IPv6；必要时用 Tailscale |
| Connection refused | Windows 22 未监听、portproxy 指向旧 WSL IP、防火墙/安全软件拦截 | 检查 `Test-NetConnection`、`netsh portproxy`、`dsh_ssh_22` 规则、360/火绒 |
| 昨天能连今天不能 | 光猫/路由器重启或运营商换前缀；WSL 重启换 IP | 用 bot 最新消息里的 IPv6；运行 `scripts/refresh-wsl-portproxy.ps1` |
| 桌面 `127.0.0.1:3080` 打不开 | Windows→WSL 的 3080 转发被删（并非公网问题） | 恢复本机 3080 转发；不要把 3080 暴露公网 |
| SSH 通了但网页 401/403 | DSH token 过期/换了；访问了错误的 Host | 重新向 bot 发消息拿最新 token 链接；隧道用 `127.0.0.1` |
| 手机只有个别网络能连 | 手机网络没有 IPv6 / 公司或校园网封入站 | 换网络验证；使用 Tailscale/Cloudflare Tunnel |
| 开了 VPN 后不能连 | VPN 改路由/DNS/防火墙 | 测试时退出 VPN；或配置分流/绕过 22 |
| bot 不回复，日志 `getupdates ... fetch failed` | Windows/WSL IPv6 临时消失时 AAAA 解析失败；或 WSL IPv4 出网中断 | 先 `curl -4 -I https://ilinkai.weixin.qq.com`；2.7.1+ 优先 IPv4，仍失败时重启插件/DSH |
| 昨天有 IPv6，今天突然没有 | Windows WLAN 的 RA/租约刷新会短暂撤回地址，日志出现 `240e:... -> <none>` | `netsh interface ipv6 show addresses` 查看；等待恢复/重连 WLAN；恢复后重发消息，DSH 无需重启 |
| 每晚/合盖后 bot 离线、IPv6 消失 | Windows 进入睡眠/Modern Standby（Kernel-Power 506/507），网络和 IPv6 全部暂停 | 在电源计划中将睡眠设为“从不”（至少插电时）；远程主机不要合盖睡眠 |
| 局域网设备能连，外网不能 | 只验证了局域网，光猫/路由器 WAN→LAN IPv6 未放行 | 用蜂窝数据复测；配置 IPv6 入站规则 |

## 8. 安全清单

- SSH **仅密钥登录**：`PasswordAuthentication no`、`PermitRootLogin no`、`AllowUsers <你的用户>`；
  插件项目里的 sshd 加固可作参考。
- 只放行 **22**，不要 DMZ 整台主机，不要把 3080 映射到公网或整个局域网。
- 光猫/路由器 IPv6 防火墙不要图省事关掉；尽量按端口/设备放行。
- Windows 上安装安全软件时，确认它不会静默重置防火墙规则。
- 手机私钥加口令/生物识别；设备丢失后从 `~/.ssh/authorized_keys` 删除对应公钥。
- 如果运营商封锁入站 IPv6，优先考虑 Tailscale/WireGuard/Cloudflare Tunnel，而不是关闭光猫防火墙。

## 9. 适用边界

- 目标环境：Windows 10/11 + WSL2（Ubuntu 等）+ DSH Web + 可入站公网 IPv6。
- 需要：管理员权限（配置 portproxy/防火墙）；手机或外网设备有 IPv6；SSH 客户端支持端口转发。
- 不适用：没有公网 IPv6、运营商锁死 IPv6 入站、或只能 IPv4 的网络（请改用覆盖网络）。
- SSH 端口默认 **22**，可通过插件配置 `sshPort` 修改；改非标端口时，需要同时修改 sshd、portproxy、
  防火墙和 `scripts/refresh-wsl-portproxy.ps1 -SshPort`。

## 10. English summary

- This bundle is for **Windows 10/11 + WSL2** homes with **inbound public IPv6**. It does not create a
  tunnel or cloud relay; the user must allow inbound TCP 22 on the ONT/router IPv6 firewall and in the
  Windows firewall.
- IPv6 has no NAT: port forwarding does not apply; add an IPv6 firewall allow rule for TCP 22.
- Chinese ISPs often use CGNAT for IPv4, so IPv6 is the practical path; IPv6 prefixes can change after
  ONT/router reboots, and the bot pushes the latest address.
- WSL2 NAT has no public IPv6; the plugin reads the Windows IPv6 and uses Windows `portproxy` to reach
  WSL sshd. WSL IP changes require refreshing the portproxy (`scripts/refresh-wsl-portproxy.ps1`).
- Keep DSH bound to `127.0.0.1:3080`; never expose 3080 publicly. If inbound IPv6 is blocked, use
  Tailscale/WireGuard/Cloudflare Tunnel instead of disabling firewalls.
