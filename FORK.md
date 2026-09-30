# Automatic thread titles

This fork publishes two tested branches with the same automatic title feature:
[`fork/stable`](https://github.com/alcxyz/t3code/tree/fork/stable) follows the
latest published upstream stable release, and
[`fork/nightly`](https://github.com/alcxyz/t3code/tree/fork/nightly) follows
the latest published upstream nightly release. Both branches are source trees
that build with T3 Code's normal tools. Nix is optional.

```sh
git clone --branch fork/stable https://github.com/alcxyz/t3code.git
cd t3code
vp i
vp run dev
```

See the upstream development instructions in [README.md](README.md) for
prerequisites. Turn on Settings → General → Text generation → Keep thread
titles current. Every fifth completed turn, the server reruns T3 Code's title
regeneration for generated titles; titles you rename yourself are never
changed. The fork also carries the regeneration indicator from
[pingdotgg/t3code#13905](https://github.com/pingdotgg/t3code/pull/13905)
until upstream merges it.

The hourly [sync workflow](https://github.com/alcxyz/t3code/actions/workflows/fork-sync.yml)
checks published upstream release tags separately for stable and nightly. It
applies the title feature to each release and advances a channel branch only
after typechecks, title tests, and the desktop build pass. A channel skips work
when its release and feature commit have not changed. Conflicts or failed
checks leave that channel at its last validated commit. Manual runs validate
the same candidate again without creating a new commit when nothing changed.
The other channel can still advance if one fails.

The `feat/automatic-thread-titles` branch is the feature source and repository
default. Its `.github/fork-source.json` declares the upstream baseline for
the feature tree delta. Each published channel has its own
`.github/fork-source.json` with the release tag, exact upstream revision, and
feature revision used to build it. Upstream release and deployment workflows
are disabled in this fork.

[Discussion and feedback](https://github.com/pingdotgg/t3code/discussions/11744)

Our Nix packaging selects a pinned channel commit. The quota-recovery patch
is not part of this title feature.
