# Community publishing checklist

> Current status (2.6.0): package name **`dsh-wechat-clawbot-access`**, GitHub repository
> **`LinkADSL/dsh-wechat-clawbot-access`**, MIT license, Node `.gitignore`, Config schema and
> tests are prepared. The GitHub repository is created (**Private**) and the local remote is configured;
> remaining steps are `git push` (with the owner's GitHub credentials) and `npm login` +
> `npm publish`.

This directory is configured for a public community package: name
`dsh-wechat-clawbot-access`, `private: false`, repository/homepage set to
`LinkADSL/dsh-wechat-clawbot-access`, MIT license and a standard Node
`.gitignore`. It is not published yet; npm login/publish and the manual GitHub
repository creation remain. Work through the remaining checklist.

## 1. Package identity

- [x] Public package name `dsh-wechat-clawbot-access`; `package.json#name`,
      `cordis.patch.yml#name`, and the `client.js` module id match.
- [x] `"private": false`.
- [x] `repository`, `homepage`, `bugs`, and `author` (`LinkADSL
      <lan_stone@foxmail.com>`) set to the public repository.
- [ ] Confirm `"files"` includes every runtime file, `README.en.md`, `cordis.patch.yml`,
      `locale`, `icon.svg`, `docs`, `scripts`, `README.md`, `LICENSE` and
      `CHANGELOG.md`; verify with `npm pack --dry-run`.
- [ ] Keep `"engines": { "node": ">=20" }` and state the tested DSH version in
      the README (the current profile runs DSH `0.2.2-rc.5`).

## 2. Required display assets

- [ ] `locale/zh.json` and `locale/en.json` have accurate `meta.title`,
      `meta.description` and (optional) `meta.detail` paths.
- [ ] `docs/DETAIL.md` / `docs/DETAIL.zh.md` each contain exactly one feature
      image line, and the referenced `docs/preview.svg` exists (text-free,
      640×300, works in light/dark themes).
- [ ] `icon.svg` is original or redistributable; keep the MIT notice for the
      vendored `qrcode-generator` (see `LICENSE`).
- [ ] README opens with: what it does, prerequisites (Windows + WSL2, inbound
      public IPv6, SSH key login), and the **no Agent / no LLM token** design.
- [ ] Link the China network guide from the README
      (`docs/NETWORK.md`) and describe the inbound IPv6 prerequisite honestly.

## 3. Security and privacy review

- [ ] No tokens, chat IDs, state files, logs or personal IPv6 addresses are
      committed; scan the repository and `package.json`.
- [ ] `state.json`, `status.json`, `dsh-web.json` and `route-secret` stay 0600
      and the daemon refuses to start with a predictable route secret.
- [ ] New contacts need explicit panel approval (pending-owner flow); document
      that `allowedUsers` is an operator trust decision.
- [ ] The plugin never forwards `3080` publicly; only SSH (22) is exposed, and
      the README explains key-only authentication.
- [ ] State the privacy boundary: WeChat bot token and reply contexts stay on
      the user's machine; the bot sends the DSH token URL to the approved WeChat
      contact by design.
- [ ] Run `npm run check && npm test` and confirm CI is green.

## 4. Publish

```bash
npm pack --dry-run           # inspect the exact file list
npm publish --access public  # public scope required for community installs
npm view @your-scope/dsh-wechat-clawbot version
```

- [ ] Test a clean install through `plugin_manager install_bundle`
      (`target=@your-scope/dsh-wechat-clawbot@x.y.z`) on a fresh DSH profile.
- [ ] Enable the bundle, scan the QR, send one WeChat message, approve the
      pending owner, verify the minimal reply, then test the SSH tunnel.
- [ ] Confirm uninstalling the bundle stops the daemon and leaves
      `~/.dsh/wechat-clawbot` intact for a later reinstall.

## 5. Community index listing

- [ ] Add the repository to the community plugin index (for example the
      `awesome-dsh-plugin` / `dsh-plugin-market` index used by DSH's Discover
      tab), with `category: notify` or `remote`, a one-line English and Chinese
      description, and a compatibility note for the tested DSH version.
- [ ] Provide at least one screenshot of the plugin page and QR modal; keep the
      preview image inside the package (do not hotlink).
- [ ] Mention known limitations prominently:
  - Windows + WSL2 only (the IPv6/portproxy helpers are Windows-specific);
  - requires inbound public IPv6; CGNAT/IPv4-only users need Tailscale or a
    tunnel;
  - SSH port defaults to 22 but is configurable (`sshPort`) if sshd/portproxy/firewall
    are updated together;
  - the bot is a pure notification/access-info bridge, not an LLM chat bridge.

## 6. Release hygiene

- [ ] Bump the version (SemVer) and add a `CHANGELOG.md` entry.
- [ ] Tag the release and attach the packed tarball if the index supports it.
- [ ] Keep `README.md` and `docs/NETWORK.md` current when the setup changes;
      community users will hit China-specific ONT/router/firewall issues.
- [ ] After publishing, do not reuse the local `@local/...` name or the
      `.dsh/wechat-clawbot` state directory in test fixtures.
