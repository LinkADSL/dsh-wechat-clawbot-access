# Community listing (awesome-dsh-plugin)

The DSH plugin community catalog is
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
**A listing does not require an npm account.** The catalog installs GitHub-only
plugins directly from their repository; npm is optional and only adds download
statistics.

## Prepared identity

- Repository: <https://github.com/LinkADSL/dsh-wechat-clawbot-access>
- Package: `dsh-wechat-clawbot-access` (unpublished npm package is fine)
- Category: `remote`
- License: MIT; `.gitignore`: Node
- `package.json` already declares `dsh.bundle` / `dsh.client` and the repository
  has `cordis.patch.yml`.

## Requirements before submitting

- [ ] Make the GitHub repository **public**. A private repository cannot be
      fetched or installed by the catalog.
- [ ] Wait until the repository is **at least 1 day old** (catalog gate).
- [ ] Add the **`dsh-plugin`** topic to the repository.
- [ ] Confirm `dsh plugin --profile web add https://github.com/LinkADSL/dsh-wechat-clawbot-access`
      installs it on a clean profile. (`plugin_manager install_bundle` accepts the
      same git URL.)

## Submission

Fork `awesome-dsh-plugin/awesome-dsh-plugin`, add exactly one file at
`data/plugins/LinkADSL__dsh-wechat-clawbot-access.yml`, and open a PR. Do not edit
the generated READMEs.

```yaml
url: https://github.com/LinkADSL/dsh-wechat-clawbot-access
name: LinkADSL/dsh-wechat-clawbot-access
category: remote
description:
  en: 'Pure-script WeChat ClawBot (iLink) bridge for DeepSeek Harness: configure SSH and port forwarding, then receive IPv6/SSH/token access info in WeChat and open the DSH Web UI on a phone, with QR login, owner approval and daily pushes. No Agent or LLM tokens.'
  zh: '纯脚本微信 ClawBot (iLink) 访问桥：配置 SSH 与端口转发后，通过微信获取 IPv6/SSH/token 信息，在手机浏览器打开 DSH Web；支持扫码登录、owner 确认和每日推送，不经过模型、不消耗 token。'
```

The English description is quoted because it contains `: `. Chinese is optional
but included.

## Optional: publish to npm

Only do this if you want download counts in the market. The package name is
`dsh-wechat-clawbot-access`, `private` is already `false`, and `npm publish
--dry-run` passes. `npm login` needs an npm account; it is **not** needed for
community listing.

## Security review note

The catalog states that listing is not a security review. Keep DSH bound to
`127.0.0.1:3080`, use SSH key-only access, and never commit bot tokens or the
DSH token URL.
