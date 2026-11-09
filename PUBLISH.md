# Publishing `dsh-recovery`

Status of everything this machine can prepare offline, and the steps that need a GitHub account.

> Target: the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
> catalogue, which powers the [dsh-market](https://github.com/dsh-market/dsh-market) plugin market.
> One YAML file per plugin, one PR.

## 0 · Repository — done

- <https://github.com/zilta-amaze/dsh-recovery> (public, `main`, tag `v0.1.0`)
- Topic `dsh-plugin` set (the catalogue CI requires it), plus `dsh`, `deepseek-harness`, `memory`,
  `context`
- `package.json` declares `dsh.bundle` → `cordis.patch.yml`, so it installs with `dsh plugin add`
- `repository`, `homepage` and `bugs` point at the repository

## 1 · CI — prepared, needs a `workflow`-scope token

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the offline suite on Node 20, 22 and 24
for every push and pull request; the README badge tracks `main`.

GitHub refuses a push that creates a workflow file unless the token carries the **`workflow`** scope
in addition to `repo`. The token used for the first upload had only `repo`, so this file is committed
locally and not yet on `main`. To finish it, create a token with both scopes:

<https://github.com/settings/tokens/new?description=dsh-recovery-ci&scopes=repo,workflow>

then push the pending commit with `git push origin main`.

## 2 · Release — done

`v0.1.0` is tagged and published:
<https://github.com/zilta-amaze/dsh-recovery/releases/tag/v0.1.0>

## 3 · Submit to the catalogue — after 2026-11-10

The gate rejects repositories younger than **1 day**, so this one can only be submitted once the
repository is a day old (created 2026-11-09 22:55 +08:00 → submit from 2026-11-10 23:00 +08:00).

1. Fork [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
2. Add exactly one file, named after the repository:

   ```text
   data/plugins/zilta-amaze__dsh-recovery.yml
   ```

   Its contents are already written in [`market/dsh-recovery.yml`](market/dsh-recovery.yml).
3. Open a PR. Title: `Add dsh-recovery`. Body:
   [`market/PR-body.md`](market/PR-body.md).

Rules that will be checked:

- **one PR ≤ 3 entries**, and only your own entry file is touched — never the generated READMEs;
- `description.en` is required and must be **accurate** (it is read as a claim and checked against
  the code);
- a `: ` inside a description must be quoted — the file in `market/` already is;
- the repository must be at least 1 day old.

CI runs in this order: entry count → `dsh.bundle` present in `package.json` → repository age →
`awesome-lint` + site build. Failures name exactly what to change; push the fix to the same branch.

## 4 · npm (optional)

Listing works without npm; publishing only adds download counts and sorting.

```sh
npm login
npm publish --access public
```

- The published `package.json` must keep `repository` pointing at the listed repo (done).
- **Do not** add an `npm:` key to the entry YAML — the mapping is picked up from the registry, and a
  hand-written one is rejected.

## 5 · Screenshots (optional)

Add `screenshots.json` next to `package.json` with 1–8 paths relative to it (no leading `/`, no
`..`), then push the images. For a market **tile**, the entry's `icon:` must be a GitHub-hosted
raster (`png`/`jpg`/`webp`); the `icon.svg` shipped for the plugin manager is not accepted there.
The market tile is already in place: `assets/icon.png` (512×512 PNG, GitHub-hosted) is declared as
`icon:` in [`market/dsh-recovery.yml`](market/dsh-recovery.yml), and `icon.svg` is the matching vector
for the plugin manager.
