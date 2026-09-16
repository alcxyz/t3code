# Automatic thread titles

Use [`feat/automatic-thread-titles`](https://github.com/alcxyz/t3code/tree/feat/automatic-thread-titles) to test this fork. It contains the complete feature and builds with T3 Code's normal tools. Nix is optional.

```sh
git clone --branch feat/automatic-thread-titles https://github.com/alcxyz/t3code.git
cd t3code
vp i
vp run dev
```

See the upstream development instructions in [README.md](README.md) for prerequisites. Use Settings → General → Projects and threads to configure automatic title updates. The thread menu's Title updates action shows its history and restore controls.

The scheduled [sync workflow](https://github.com/alcxyz/t3code/actions/workflows/fork-sync.yml) updates `main` to upstream, then merges upstream into a local feature candidate. The feature branch advances only after typechecks, title tests, and the desktop build pass. Conflicts or failed checks leave it at its last validated commit. Manual workflow runs use the same checks.

`main` is an exact upstream mirror. This feature branch is the repository default so GitHub runs the fork's own scheduled workflow. Upstream release/deployment workflows are disabled in this fork.

[Discussion and feedback](https://github.com/pingdotgg/t3code/discussions/11744)

Our Nix packaging consumes a pinned feature commit separately. The quota-recovery patch is not part of this title feature.
