import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
FEATURE = "feat/automatic-thread-titles"


class ForkSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.origin = self.root / "origin.git"
        self.upstream = self.root / "upstream.git"
        self.source = self.root / "source"
        self.runner = self.root / "runner"
        self.output = self.root / "github-output"
        self.summary = self.root / "github-summary"
        self.releases = self.root / "releases.json"

        self.git("init", "--bare", "--initial-branch=main", str(self.origin))
        self.git("init", "--bare", "--initial-branch=main", str(self.upstream))
        self.git("init", "--initial-branch=main", str(self.source))
        self.identity(self.source)
        (self.source / ".github").mkdir()
        (self.source / "apps/server").mkdir(parents=True)
        (self.source / "apps/server/package.json").write_text('{"version":"0.9.0"}\n')
        (self.source / "shared.txt").write_text("base\n")
        self.git("add", ".", cwd=self.source)
        self.git("commit", "-m", "base", cwd=self.source)
        self.base = self.rev(self.source)
        self.git("remote", "add", "origin", str(self.origin), cwd=self.source)
        self.git("remote", "add", "upstream", str(self.upstream), cwd=self.source)
        self.git("push", "origin", "main", cwd=self.source)
        self.git("push", "upstream", "main", cwd=self.source)
        self.tag_release("v1.0.0", self.base, prerelease=False)
        self.tag_release("v1.0.0-nightly.20260929.1", self.base, prerelease=True)

        self.git("switch", "-c", FEATURE, cwd=self.source)
        self.control_metadata(self.base)
        (self.source / "feature.txt").write_text("automatic titles\n")
        self.git("add", ".", cwd=self.source)
        self.git("commit", "-m", "feature", cwd=self.source)
        self.git("push", "origin", FEATURE, cwd=self.source)
        self.feature_head = self.rev(self.source)

        self.git("clone", "--branch", FEATURE, str(self.origin), str(self.runner))
        self.identity(self.runner)

    def git(self, *args, cwd=None, check=True):
        return subprocess.run(
            ["git", *args], cwd=cwd, check=check, text=True, capture_output=True
        )

    def identity(self, repo):
        self.git("config", "user.name", "Fork Sync Tests", cwd=repo)
        self.git("config", "user.email", "fork-sync-tests@example.invalid", cwd=repo)

    def rev(self, repo, revision="HEAD"):
        return self.git("rev-parse", revision, cwd=repo).stdout.strip()

    def remote_rev(self, branch):
        return self.rev(self.origin, f"refs/heads/{branch}")

    def control_metadata(self, baseline):
        (self.source / ".github/fork-source.json").write_text(
            json.dumps({"upstreamRevision": baseline, "version": "0.9.0"}) + "\n"
        )

    def tag_release(self, tag, revision, *, prerelease):
        self.git("fetch", "--no-tags", "upstream", "main", cwd=self.source)
        self.git("-c", "tag.gpgSign=false", "tag", tag, revision, cwd=self.source)
        self.git("push", "upstream", tag, cwd=self.source)
        if self.releases.exists():
            releases = json.loads(self.releases.read_text())
        else:
            releases = []
        releases.append({
            "tag_name": tag,
            "draft": False,
            "prerelease": prerelease,
            "published_at": f"2026-09-30T00:{len(releases):02}:00Z",
        })
        self.releases.write_text(json.dumps(releases))

    def advance_upstream(self, filename="upstream.txt", content="upstream\n"):
        upstream_work = self.root / "upstream-work"
        if not upstream_work.exists():
            self.git("clone", "--branch", "main", str(self.upstream), str(upstream_work))
            self.identity(upstream_work)
        (upstream_work / filename).write_text(content)
        self.git("add", ".", cwd=upstream_work)
        self.git("commit", "-m", "upstream release", cwd=upstream_work)
        self.git("push", "origin", "main", cwd=upstream_work)
        return self.rev(upstream_work)

    def reset_runner(self):
        self.git("fetch", "origin", FEATURE, cwd=self.runner)
        self.git("reset", "--hard", f"origin/{FEATURE}", cwd=self.runner)

    def run_sync(self, mode, channel, *, expected=None, force=False, branch=FEATURE):
        self.output.write_text("")
        self.summary.write_text("")
        env = os.environ.copy()
        env.update({
            "GITHUB_OUTPUT": str(self.output),
            "GITHUB_STEP_SUMMARY": str(self.summary),
            "GIT_ALLOW_PROTOCOL": "file",
            "GIT_TERMINAL_PROMPT": "0",
            "FORK_RELEASES_JSON_FILE": str(self.releases),
            "FORK_UPSTREAM_URL": str(self.upstream),
            "FEATURE_BRANCH": branch,
        })
        if force:
            env["FORCE_VALIDATION"] = "true"
        else:
            env.pop("FORCE_VALIDATION", None)
        if expected:
            env.update({
                "EXPECTED_FEATURE_HEAD": expected["feature_head"],
                "EXPECTED_PREVIOUS_HEAD": expected["previous_head"],
                "EXPECTED_CANDIDATE_HEAD": expected["candidate_head"],
            })
        return subprocess.run(
            ["bash", str(SCRIPTS / "fork-sync.sh"), mode, channel],
            cwd=self.runner, env=env, text=True, capture_output=True
        )

    def outputs(self):
        return dict(line.split("=", 1) for line in self.output.read_text().splitlines())

    def succeeded(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def promote(self, channel):
        self.reset_runner()
        self.succeeded(self.run_sync("prepare", channel))
        output = self.outputs()
        self.succeeded(self.run_sync("publish", channel, expected=output))
        return output

    def test_channels_start_from_exact_published_tags_and_skip_unchanged(self):
        stable = self.promote("stable")
        self.assertEqual(stable["upstream_head"], self.base)
        nightly = self.promote("nightly")
        self.assertEqual(nightly["upstream_head"], self.base)
        self.assertEqual(self.remote_rev("fork/stable"), stable["candidate_head"])
        self.assertEqual(self.remote_rev("fork/nightly"), nightly["candidate_head"])
        metadata = json.loads(self.git(
            "show", "fork/stable:.github/fork-source.json", cwd=self.origin
        ).stdout)
        self.assertEqual(metadata, {
            "channel": "stable", "releaseTag": "v1.0.0", "version": "1.0.0",
            "upstreamRevision": self.base, "featureRevision": self.feature_head,
        })
        self.reset_runner()
        self.succeeded(self.run_sync("prepare", "stable"))
        self.assertEqual(self.outputs(), {"validate": "false"})
        self.assertEqual(self.remote_rev("main"), self.base)

    def test_feature_update_rebuilds_same_release_with_fast_forward(self):
        old = self.promote("stable")["candidate_head"]
        (self.source / "more-feature.txt").write_text("new behavior\n")
        self.git("add", ".", cwd=self.source)
        self.git("commit", "-m", "feature update", cwd=self.source)
        self.git("push", "origin", FEATURE, cwd=self.source)
        updated = self.promote("stable")
        self.assertEqual(updated["previous_head"], old)
        self.assertEqual(updated["upstream_head"], self.base)
        self.succeeded(self.git(
            "merge-base", "--is-ancestor", old, updated["candidate_head"], cwd=self.runner
        ))
        self.assertEqual(self.git(
            "show", "fork/stable:more-feature.txt", cwd=self.origin
        ).stdout, "new behavior\n")

    def test_new_release_rebuilds_only_changed_channel(self):
        stable = self.promote("stable")
        nightly = self.promote("nightly")
        newer = self.advance_upstream()
        self.tag_release("v1.0.1-nightly.20260930.2", newer, prerelease=True)
        promoted = self.promote("nightly")
        self.assertEqual(promoted["upstream_head"], newer)
        self.assertEqual(promoted["previous_head"], nightly["candidate_head"])
        self.reset_runner()
        self.succeeded(self.run_sync("prepare", "stable"))
        self.assertEqual(self.outputs(), {"validate": "false"})
        self.assertEqual(self.remote_rev("fork/stable"), stable["candidate_head"])

    def test_conflict_keeps_channel_unchanged(self):
        old = self.promote("stable")["candidate_head"]
        (self.source / "shared.txt").write_text("feature change\n")
        self.git("add", ".", cwd=self.source)
        self.git("commit", "-m", "change shared file", cwd=self.source)
        self.git("push", "origin", FEATURE, cwd=self.source)
        newer = self.advance_upstream("shared.txt", "upstream change\n")
        self.tag_release("v1.1.0", newer, prerelease=False)
        self.reset_runner()
        result = self.run_sync("prepare", "stable")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.remote_rev("fork/stable"), old)

    def test_feature_race_blocks_publish(self):
        prepared = self.promote("stable")
        self.reset_runner()
        self.succeeded(self.run_sync("prepare", "stable", force=True))
        output = self.outputs()
        self.assertEqual(output["candidate_head"], prepared["candidate_head"])
        (self.source / "race.txt").write_text("race\n")
        self.git("add", ".", cwd=self.source)
        self.git("commit", "-m", "race", cwd=self.source)
        self.git("push", "origin", FEATURE, cwd=self.source)
        self.assertNotEqual(self.run_sync("publish", "stable", expected=output).returncode, 0)
        self.assertEqual(self.remote_rev("fork/stable"), prepared["candidate_head"])

    def test_channel_race_blocks_publish(self):
        self.promote("stable")
        self.reset_runner()
        self.succeeded(self.run_sync("prepare", "stable", force=True))
        output = self.outputs()
        racer = self.root / "racer"
        self.git("clone", "--branch", "fork/stable", str(self.origin), str(racer))
        self.identity(racer)
        (racer / "race.txt").write_text("race\n")
        self.git("add", ".", cwd=racer)
        self.git("commit", "-m", "race", cwd=racer)
        self.git("push", "origin", "fork/stable", cwd=racer)
        racing_head = self.rev(racer)
        self.assertNotEqual(self.run_sync("publish", "stable", expected=output).returncode, 0)
        self.assertEqual(self.remote_rev("fork/stable"), racing_head)

    def test_forced_validation_keeps_existing_commit(self):
        first = self.promote("stable")
        self.reset_runner()
        self.succeeded(self.run_sync("prepare", "stable", force=True))
        output = self.outputs()
        self.assertEqual(output["candidate_head"], first["candidate_head"])
        self.succeeded(self.run_sync("publish", "stable", expected=output))
        self.assertEqual(self.remote_rev("fork/stable"), first["candidate_head"])

    def test_control_branch_cannot_be_channel(self):
        result = self.run_sync("prepare", "stable", branch="fork/stable")
        self.assertNotEqual(result.returncode, 0)

    def test_dispatch_can_use_maintenance_control_branch(self):
        self.git("push", "origin", "HEAD:refs/heads/maintenance", cwd=self.source)
        self.git("fetch", "origin", "maintenance", cwd=self.runner)
        self.git("switch", "-c", "maintenance", "origin/maintenance", cwd=self.runner)
        self.succeeded(self.run_sync("prepare", "stable", branch="maintenance"))
        self.assertEqual(self.outputs()["feature_head"], self.feature_head)

    def test_release_selector_rejects_drafts_and_wrong_channels(self):
        from importlib.util import module_from_spec, spec_from_file_location
        spec = spec_from_file_location("fork_release", SCRIPTS / "fork-release.py")
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        releases = json.loads(self.releases.read_text())
        releases.extend([
            {"tag_name": "v9.0.0", "prerelease": True, "draft": False,
             "published_at": "2026-09-30T09:00:00Z"},
            {"tag_name": "v9.0.0-nightly.20260930.9", "prerelease": True,
             "draft": True, "published_at": "2026-09-30T10:00:00Z"},
            {"tag_name": "v9.0.0-preview.20260930.9", "prerelease": True,
             "draft": False, "published_at": "2026-09-30T11:00:00Z"},
        ])
        self.assertEqual(module.select("stable", releases), ("v1.0.0", "1.0.0"))
        self.assertEqual(
            module.select("nightly", releases),
            ("v1.0.0-nightly.20260929.1", "1.0.0-nightly.20260929.1"),
        )


if __name__ == "__main__":
    unittest.main()
