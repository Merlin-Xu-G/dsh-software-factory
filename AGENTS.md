# AGENTS.md

This repository holds `@local/dsh-software-factory`, a DSH (DeepSeek Harness)
Host plugin bundle: the `/factory` slash command, an 8-phase software-delivery
pipeline driven through DSH-native machinery, plus a Web-client right-sidebar
tab that observes pipeline progress.

## Layout

- `package.json` — bundle manifest (`dsh.bundle.patch`, `dsh.client` web section).
- `cordis.patch.yml` — the single Loader insert row (`id: software-factory`).
- `index.js` — Host half: Config schema (Standard Schema `~standard`), the
  `/factory` command, the `.factory.yml` project-override reader, and the
  `factory` session projection that derives progress from the session log.
- `client.js` — Web half (ModuleLoader factory): the right-sidebar "Factory"
  tab over the projection's wire view.
- `locale/en.json`, `locale/zh.json` — Plugin Manager display metadata.
- `icon.svg` — card icon. `README.md` — full documentation, including the
  `.factory.yml` format.

## Conventions

- **Verification bar**: every change ends with `node --check` on each touched
  `.js` file plus a behavioral smoke run (see `.tmp` scratch in the settings
  repo); quote the real outputs in the report. Never claim success without
  same-turn on-disk evidence.
- **No agent git commits** in this repository. The user and the Lead review;
  they commit. Do not run `plugin_manager` here either: installation happens
  from the settings repo's session by the Lead/user.
- **Reinstall + restart**: after this package is (re)installed into a profile,
  the running Host keeps serving the old module generation until DSH restarts.
- **`.factory.yml`**: this repository may carry one (it does not today); the
  format is documented in README.md. It only affects `/factory` runs whose
  session workspace is this repository.
- **No machine-specific absolute paths** in any tracked file; resolve from
  environment or configuration.
- **Dependencies**: none at runtime. Host schemas are dependency-free
  facades over the protocols Cordis actually calls (`~standard.validate`,
  `schema.parse`); the client half imports React only through the browser
  module table and styles exclusively with `--dsw-alias-*` theme tokens.
