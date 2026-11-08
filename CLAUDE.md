# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`dsh-git-plugin` is a pnpm-workspace monorepo implementing a Git plugin for DeepSeek Harness (dsh). v1 covers workspace change awareness, stage/unstage/discard, commit (including AI-generated messages), push/pull/fetch, and a commit graph.

| Path | npm name | Role |
|---|---|---|
| `packages/host` | `dsh-gitkit` | Node-side Cordis plugin. A `TypertRemoteService` exposed on wire namespace `git` with 38 `@Remote` methods. |
| `packages/client-ui` | `dsh-gitkit-ui` | Web client bundle: header entry, Changes tab, Commit-graph tab. |
| `git-bundle` | `dsh-gitkit-bundle` | Zero-code release shim and the single `file:` install entry; pulls both packages into a dsh profile. |
| `packages/typert-protocol` | `@deepseek-ai/dsh-typert-protocol` | Unmodified vendored npm copy (0.2.2-alpha.2), build-time/type-plane only. |

Two scope constraints shape the code: v1 is one session = one repository; dsh exposes no event broadcast to out-of-tree plugins, so host→client updates use a `followStatus` typert stream plus write-invalidation rather than events.

The authoritative interface spec is committed in-repo at `docs/capability-spec.md` (also `docs/feature-checklist.md`, `docs/host-capability-map.md`, `docs/ported-sources/SOURCES.md`). The dsh source tree is read-only reference at `D:\DeepSeekHarness` (override with `DSH_TREE`); never write into it.

## Commands

Run from the repository root. The README's `pnpm --dir dsh-git-plugin …` form assumes the parent directory; drop `--dir` here.

```bash
pnpm install                 # workspace install
pnpm run typecheck           # build:host (typert generation) then tsc for root/host/client
pnpm run build               # host bundle + typert artifacts + client bundle + git-bundle checks
pnpm test                    # vitest run (49 spec files; case count: unknown, not captured from a run)
pnpm exec vitest run packages/host/tests/status.spec.ts   # one file
pnpm exec vitest run -t "substring of test name"          # one test by name
pnpm run check:locale        # zh/en key+placeholder parity and no bare JSX strings
pnpm run verify:load         # full integration against a real dsh host (builds first)
pnpm run verify:install      # clean-profile install smoke, two phases (working-copy + clean clone; does NOT build the working copy — run build first)
```

`typecheck` runs `build:host` first on purpose: typert generation produces descriptor artifacts that the later `tsc` runs and tests consume.

Both workflows run the same gate on `windows-latest`: `.github/workflows/ci.yml` (every push/PR) and `release.yml` run `pnpm install --frozen-lockfile` → `typecheck` → `test` → `build` → verify install matrix (npm latest column: `node scripts/verify-install.mjs` with `DSH_SPEC=@deepseek-ai/dsh@0.2.1-rc.5`; no `DSH_VERIFY_ALLOW_SKIP`, so an npm-column failure or skip exits non-zero and fails the step. CI sets `DSH_VERIFY_INSTALL_SKIP_CLONE=1` — the clean-clone phase stays a local release-gate concern).

Toolchain recorded by the README: Node 22.21.0, pnpm 11.8.0, git 2.55.0.windows.2. The plugin declares `engines.dsh >= 0.2.1-rc.5` — the only released dsh version against which the plugin's consumed API surface has been compared symbol-by-symbol at source level (a static comparison; the on-host load test is a pre-release gate, not yet run). Two-generation host semantics: engines-first hosts (the 0.2.1 line onward) decide on `engines.dsh` alone (`includePrerelease:true`), peerDependencies not consulted; peer-only hosts (≤0.2.0.x) ignore engines and evaluate peerDependencies. First-hand evidence for the peer-only generation covers only the `dsh-v0.2.0-rc.1`/`dsh-v0.2.0-rc.2` tags and the 0.1.7-rc.2 CLI; the remaining 0.2.0.x versions are inferred, not verified.

### Release and publishing

- Four manifests must stay on one version: root `package.json`, `packages/host`, `packages/client-ui`, and `git-bundle`. `scripts/build-client.mjs` fail-closed asserts all four equal **and** that the root `description` and `README.md` anchor the same `v<version>` (it runs inside `pnpm run build`, so the push-CI build gate enforces it); `release.yml` asserts tag (`v` stripped) == host == client. Bump all four plus the description/README anchor before tagging or the gate fails.
- Pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes **only** `dsh-gitkit` and `dsh-gitkit-ui` via `pnpm -r --filter … publish --no-git-checks`. Do not switch to a bare `pnpm -r publish`: the vendored `@deepseek-ai/dsh-typert-protocol` would be published too.
- `workflow_dispatch` is the manual re-publish channel and is **fail-closed anchored to the tagged release**: a gate step asserts host/client manifest versions are equal, that tag `v<version>` exists, and that it resolves exactly to the checkout `GITHUB_SHA` — otherwise it throws and Publish never executes (the npm 0.1.1 vs tag v0.1.1 content-mismatch lesson). Requires the `NPM_TOKEN` repository secret.
- After Publish, `scripts/verify-release-tarball.mjs` (detective layer) compares the just-published registry tarball byte-for-byte against a repack of the current checkout — the tag channel checks out the tag and the dispatch channel is anchored to the same commit, so "repack of this checkout" ≡ "repack of a tag checkout". Any mismatch exits 1: compare the stderr diff list manually instead of rerunning (a rerun hits the same-version republish rejection in Publish).
- Both published packages declare `prepack: pnpm -w run build`, so publishing always rebuilds host/client artifacts. `git-bundle` is never published to npm (its `file:../packages/...` dependencies cannot resolve remotely); it ships via git/local `file:` installs.

## Architecture

### RPC pipeline (host → client)

1. `packages/host/src/index.ts` defines `GitService extends TypertRemoteService`, calls `super(ctx, 'git')` with a **string literal** service key (a typert-generator contract), declares `static inject = ['subprocess']`, `static Config` (schemastery), and the `@Remote` methods.
2. `pnpm run build:host` runs tsdown with `typertPlugin({mode:'workspace'})`. The generator writes `lib/typert.host.js/.d.ts` (strict descriptors, auto-registered by the host's typert-loader through `exports["./typert"]`) and `lib/typert.remote-client.js/.d.ts` (client codec contribution through `exports["./remote"]`). **Never hand-edit these files.**
3. The client imports the generated contribution (`import gitRemote from 'dsh-gitkit/remote'`), mounts it with `ctx.remote.$mount(gitRemote)` in `packages/client-ui/src/client/remote/mount.ts`, and wraps the namespace in `createGitRpcClient`, which folds carrier failures into `gateway/service-unavailable`.
4. Stores consume that RPC face; components consume stores through slot `inject` objects.

Three method lists must stay identical: host `REMOTE_METHODS`, the generated descriptor's `methods` keys, and client `GIT_NAMESPACE_METHODS` / `GitRpcFace` / `GitNamespaceFace`. `packages/client-ui/tests/loader-composition.spec.ts` fails if they drift.

`followStatus` is `@Remote({mode:'stream'})` and returns `RemoteStream<GitStatusFrame, GitFollowCommand>` directly — not a Promise; the generator only accepts Iterable/AsyncIterable/RemoteStream as the direct return type.

### Host internals

- **Four `GitRunner` instances** (`git-runner.ts`): `readonly`, `write`, `commit`, `network` — two prefix sets across three timeout tiers (`readonly`/`write` share `fastTimeoutMs`). All instances get `-c safe.bareRepository=explicit`; read-only additionally gets `--no-optional-locks -c core.hooksPath=/dev/null -c core.fsmonitor=false`. Write/commit/network keep user hooks and normal locks. Timeouts: `fastTimeoutMs` (readonly/write), `commitTimeoutMs`, `networkTimeoutMs`. Every spawn uses a scrubbed env (`GIT_TERMINAL_PROMPT=0`, `GIT_LITERAL_PATHSPECS=1`, `LC_ALL=C`, inherited repo/config selectors tombstoned).
- **Engines**, one per concern: `workspace.ts` (resolve repo root: `Config.workspaceOverride` → latest top-level session `header.cwd` → `git/session-workspace-unresolved`), `status.ts` (porcelain v2 + concurrent numstat, 1.5 s cache, in-flight dedupe), `status-parser.ts` (v2 parser + v1 fallback + numstat), `diff.ts` (worktree/staged, per-file and total patch budgets), `mutations.ts` (stage/unstage/discard with guards), `commit.ts` (identity → nothing-staged → message → hook classification), `remote-ops.ts` (upstream tri-state, diverged prechecks, stderr classifier), `refs-admin.ts` (branch/tag/remote/worktree admin: existence precheck → mutation → invalidate; force actions double-gated by `acknowledged` — all parsers self-written), `message-gen.ts` (staged diff → trim → LLM route → validate), `graph.ts` (log pagination with `limit+1` over-fetch, refs, commit detail).
- **`watcher.ts`** watches `.git/index`, `.git/HEAD`, and the repo root at depth 0, debounces 150 ms, and falls back to `pollIntervalMs` (default 60 s). It emits R1 initial / R2 change-only / R3 mutation / R4 poll / R5 manual / R6 degraded frames and refcounts subscriptions. Nested-directory edits can only be seen by the poll.
- **Errors** are domain codes `git/<kebab>` carried by `RemoteError`. `error-codes.ts` augments `RemoteErrorDetailsMap` so each code's `details` is typed. stderr is always passed through `sanitizeStderr` before it reaches details, logs, or the wire. Exit codes are results unless `assertGitOk` says otherwise; truncated stdout is an error, never silently parsed.
- **Logging**: reads at `debug`, writes at `info`, failures at `warn` with the code. Never log commit message bodies or file contents.

### Client internals

`packages/client-ui/src/client/index.ts` `apply(ctx)`:

- registers the `git` locale namespace and binds `t`;
- creates root-scope data stores (`git-status-source`, `git-changes-store`, `git-graph-store`) and one shared `commitDialogFace`, all cleaned up via `ctx.effect` and reset on `connection/reset`;
- mounts `remote.git` — deliberately **not** listed in `inject`, because the namespace only exists after this `apply` mounts it; declaring it would deadlock the fiber;
- registers two right-side tab definitions and keyed tab bodies (`sidebar.right.pane.tab`): changes (`dsh-plugin.git.changes`, `keepMounted:false`) and graph (`dsh-plugin.git.graph`, `keepMounted:true`);
- registers the header button at `conversation.session.header.utilities` with `order: -10`.

Data stores are root-scope (generation/reset semantics); tab UI state uses per-slot stores. Status is stream-driven: the source opens one `followStatus` stream and drops stale-generation and unchanged-signature frames.

The client bundle is not built by tsdown. `scripts/build-client.mjs` uses rolldown to produce CJS, then wraps it in `window.__ModuleLoader__.load({id, factory})`. React and the dsh client packages are externals resolved through the injected `require`; the externals list mirrors the dsh baseline and must include anything the browser already provides. Stylesheets (`packages/client-ui/src/client/styles/git.css`, the sole entry, plus any `.css`/`.module.css` import) are compiled by lightningcss in the same build and inlined as a `style` injector tagged `data-plugin-css` — the client-modules protocol serves a single JS file, so the bundle must carry its own styles; `git.css` may only reference host design tokens (`--dsw-alias-*`/`--dsw-static-*`/`--dsw-font-*`/`--dsw-radius-*`), never hardcoded colors.

### Build outputs

`lib/` is git-ignored globally. Host `lib/` and client `lib/` are build products; `packages/typert-protocol/lib` is a vendored input, not a build product — do not delete it. If the vendored package is ever committed, it needs `git add -f` for `lib/`.

`pnpm run build` = `build:host` + `build:client`. `scripts/build-client.mjs` emits the wrapped CJS bundle, then performs the git-bundle consistency check: its version equals the root version, dependencies are exactly the two `file:` specs, patch rows name the right ids/packages, and the license trio exists. Two `tsc` passes after rolldown produce the node entry declarations (`tsconfig.build.json`) and the `lib/client/*.d.ts` tree (`tsconfig.build.client.json`) that `exports["./client"].types` points at.

`pnpm-workspace.yaml` pins `vite` 8.2.2 / `rolldown` 1.2.7 (matching the dsh tree's lockfile) to reuse the shared pnpm store; changing them can trigger native-binding downloads or version skew with dsh.

## Cross-cutting contracts

- **Wire types** (`packages/host/src/types.ts`): only null/string/boolean/finite number/plain objects/arrays cross the RPC boundary. No `Map`/`Set` in outputs, `Date` only as ISO strings, optional inputs omitted rather than passed as `undefined`. The strict codec drops fields not declared in the type.
- **Error catalog**: `git/no-repository`, `identity-missing`, `nothing-staged`, `empty-message`, `no-upstream`, `no-remote`, `diverged`, `push-rejected`, `auth-failed`, `pull-diverged`, `timeout`, `git-error`, `llm-route-unresolved`, `llm-failed`, `session-workspace-unresolved`, `no-paths`, `bad-request`, `hook-failed`, `no-branch`, `dirty-worktree`, `choose-remote`, `branch-exists`, `tag-exists`, `branch-not-found`, `tag-not-found`, `branch-not-merged`, `worktree-failed`, `blame-oversized`, `merge-conflict`, `unknown-revision`, `operation-in-progress`, `stage-patch-failed`, `stash-not-found`, `commit-blocked`. Clients switch on `code`, never `instanceof`.
- **Locale**: `packages/client-ui/src/client/locales.ts` must stay import-free (the checker evaluates it directly). `gitZh` is the key authority; every key and `{placeholder}` must exist in both `gitZh` and `gitEn`; JSX may not contain bare user-visible strings. `pnpm run check:locale` plus `packages/client-ui/tests/locales.spec.ts` enforce this.
- **Manifests**: host `exports` must expose `./typert` and `./remote` with the exact shapes; `files` must include `lib/index.js`, `lib/types.js`, `lib/*.d.ts`, the four typert artifacts, `locale`, `cordis.patch.yml`, and the license trio (the `lib/*.d.ts` glob covers per-module declarations — dropping it produces type-less tarballs). Client `files` is `lib` plus the patch and license trio; `dsh.client.platform` is `web`, `exports["./client"]` must exist, and `dsh.client.inject` must include `dsh-gitkit` plus the client packages/slots it consumes. Each package's `cordis.patch.yml` `id`/`name` must match its identity. `tests/skeleton.spec.ts` asserts all of this.
- **Typert workspace root**: the generator locates the workspace by finding a directory that contains both `tsconfig.host.json` and `packages/`, then follows `projectReferences`. Do not remove or rename `tsconfig.host.json`, and keep `packages/host` + `packages/typert-protocol` in its references. `pnpm-workspace.yaml` links `@deepseek-ai/dsh-typert-protocol` to `packages/typert-protocol` because the generator only registers packages under the root `packages/`; do not replace that with a registry dependency.
- **Licensing/porting (hard gate)**: every ported file is registered in `NOTICE.md` §2 and `PORTING.md` with an A/B/C tier. A-tier (code copied/adapted) files need the `/*! Ported from repo@commit … License … Modifications … SPDX … */` header; B/C tiers need an in-file note or a PORTING.md row. Forbidden sources — GitLens `packages/plus/**`, mhutchie/vscode-git-graph, gitamine (GPL-3.0) — must not appear in code. `tests/licenses.spec.ts` enforces existence, provenance, headers, banned identifiers, and the release files.
- **Release docs**: `LICENSE` and `NOTICE.md` must be byte-identical across root, `packages/host`, `packages/client-ui`, and `git-bundle`; `THIRD_PARTY_NOTICES.md` must be identical across all four. Edit one, copy to the others, or the test fails.

## Tests and verification

- `vitest.config.ts` includes `packages/*/tests/**/*.spec.ts` and `tests/**/*.spec.ts` — 49 files total (22 host, 25 client, 2 root compliance guards); the case count is unknown — not captured from a run (earlier docs recorded two disagreeing figures — assert neither). It runs the Node environment with `maxWorkers` capped at 6 (`min(6, cores - 1)`; higher counts starve the real-git/timeout assertions) and a pre-transform plugin for TC39 decorators so `@Remote` sources parse.
- Host tests create real temporary git repositories and assert the world by re-reading it (`packages/host/tests/support.ts` provides `scratchRepo`, `git`, a real-spawn `SubprocessFace`, and a chokidar-backed fs face). Client tests use fake RPC faces and view-model assertions.
- `verify:load` covers the deep path (both packages installed, real host, RPC round-trips for status/commit/graph/AI negative path). `verify:install` is the release gate and runs **two phases**: `working-copy` (fresh `DSH_HOME`/profile → single `file:` git-bundle install → dump-config two id lines → web boot → `git/status` ready → served HTML contains both packages) and `clean-clone` (`git clone` of this repo at committed HEAD → `pnpm install --frozen-lockfile` + `pnpm run build` inside the clone → the same assertion chain; `DSH_VERIFY_INSTALL_SKIP_CLONE=1` skips it, which CI sets explicitly — the clean-clone phase stays a local release-gate concern). Both scripts take their column from `scripts/verify-target.mjs`: default = dev-tree column (CLI source entry from `DSH_TREE`, strict assertions), `DSH_SPEC=@deepseek-ai/dsh@<ver>` = npm column (npm view probe + temp-prefix install, relaxed assertions with WARN), `DSH_BIN=<pkgRoot>/lib/bin.js` = prebuilt-binary column (setting both → exit 1); exit codes 0=pass / 1=fail / 2=skip (npm column: missing npm-cli.js or failed view/install without `DSH_VERIFY_ALLOW_SKIP=1`; with ALLOW the run exits 0 but the RESULT line reads `outcome=SKIPPED-ALLOWED` — a skip is never recorded as a pass). Both create a temporary `DSH_HOME`, kill host process trees, and clean up.

## Environment limits worth remembering

- Nested-directory edits may take up to `pollIntervalMs` (60 s) to appear; top-level files and `.git/index`/`.git/HEAD` are near-real-time.
- `GIT_TERMINAL_PROMPT=0` prevents hangs, but Git Credential Manager may still open a desktop auth window. Without a credential helper the result is `git/auth-failed` with redacted stderr.
- AI commit messages require `llmProvider`/`llmModel` or a captured session route; otherwise `git/llm-route-unresolved` is expected.
- All header menu actions are wired: changes, graph, commit, commit-push, push, pull, fetch (the v1 `sync` placeholder row was replaced by three real rows), plus branch create/switch/delete, tag create/delete, and worktree add/remove dialogs (V2 batch one).
- v1 does not expand submodules and is single-session/single-repository.

## Repository map

```
packages/host/src/        index.ts (service, @Remote, Config, REMOTE_METHODS)
                          git-runner.ts status.ts status-parser.ts diff.ts workspace.ts
                          mutations.ts commit.ts remote-ops.ts refs-admin.ts message-gen.ts graph.ts
                          watcher.ts error-codes.ts types.ts
                          blame.ts rev-count.ts time-travel.ts（v2 批次二）
                          staging-patch.ts stash.ts guard-scan.ts diagnostics.ts（v2 批次三）
packages/host/tests/      support.ts + 22 specs
packages/client-ui/src/client/  index.ts (apply), remote/mount.ts, locales.ts, ui-model.ts,
                          admin-face.ts admin-view-model.ts,
                          blame-view.ts graph-compare.ts graph-search.ts wip-node.ts（v2 批次二）,
                          changes-ops-face.ts stash-view-model.ts（v2 批次三）,
                          store/*, components/*, graph/*, diff/*, m13/*
packages/client-ui/tests/ 25 specs
scripts/                  build-client.mjs (bundle + git-bundle check) check-locale.mjs
                          verify-load.mjs verify-install.mjs verify-target.mjs verify-release-tarball.mjs
tests/                    skeleton.spec.ts licenses.spec.ts
docs/                     capability-spec.md feature-checklist.md host-capability-map.md
                          ported-sources/SOURCES.md
.github/workflows/        ci.yml (push/PR gate) release.yml (tag/manual npm publish)
```
