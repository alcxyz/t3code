import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("fork-sync.sh").resolve()
FEATURE = "feat/automatic-thread-titles"
UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git"


class ForkSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.origin = self.root / "origin.git"
        self.upstream = self.root / "upstream.git"
        self.source = self.root / "source"
        self.output = self.root / "github-output"
        self.summary = self.root / "github-summary"

        self.git("init", "--bare", "--initial-branch=main", str(self.origin))
        self.git("init", "--bare", "--initial-branch=main", str(self.upstream))
        self.git("init", "--initial-branch=main", str(self.source))
        self.configure_identity(self.source)
        (self.source / "apps/server").mkdir(parents=True)
        (self.source / ".github").mkdir()
        (self.source / "apps/server/package.json").write_text(
            json.dumps({"version": "1.0.0"}) + "\n"
        )
        (self.source / ".github/.keep").write_text("")
        (self.source / "shared.txt").write_text("base\n")
        self.git("add", ".", cwd=self.source)
        self.git("commit", "-m", "base", cwd=self.source)
        self.base = self.rev(self.source)
        self.git("remote", "add", "origin", str(self.origin), cwd=self.source)
        self.git("remote", "add", "upstream", str(self.upstream), cwd=self.source)
        self.git("push", "origin", "main", cwd=self.source)
        self.git("push", "upstream", "main", cwd=self.source)

        self.git("switch", "-c", FEATURE, cwd=self.source)
        (self.source / "feature.txt").write_text("automatic titles\n")
        self.git("add", "feature.txt", cwd=self.source)
        self.git("commit", "-m", "feature", cwd=self.source)
        self.feature_head = self.rev(self.source)
        self.git("push", "origin", FEATURE, cwd=self.source)

        self.upstream_work = self.root / "upstream-work"
        self.git("clone", "--branch", "main", str(self.upstream), str(self.upstream_work))
        self.configure_identity(self.upstream_work)

        self.runner = self.root / "runner"
        self.git("clone", "--branch", FEATURE, str(self.origin), str(self.runner))
        self.configure_identity(self.runner)
        self.git(
            "config",
            f"url.{self.upstream.as_uri()}.insteadOf",
            UPSTREAM_URL,
            cwd=self.runner,
        )

    def git(self, *args, cwd=None, check=True):
        return subprocess.run(
            ["git", *args],
            cwd=cwd,
            check=check,
            text=True,
            capture_output=True,
        )

    def configure_identity(self, repo):
        self.git("config", "user.name", "Fork Sync Tests", cwd=repo)
        self.git("config", "user.email", "fork-sync-tests@example.invalid", cwd=repo)

    def rev(self, repo, revision="HEAD"):
        return self.git("rev-parse", revision, cwd=repo).stdout.strip()

    def remote_rev(self, branch):
        return self.rev(self.origin, f"refs/heads/{branch}")

    def advance_upstream(self, filename="upstream.txt", content="upstream\n"):
        (self.upstream_work / filename).write_text(content)
        package = self.upstream_work / "apps/server/package.json"
        package.write_text(json.dumps({"version": "1.1.0"}) + "\n")
        self.git("add", ".", cwd=self.upstream_work)
        self.git("commit", "-m", "upstream change", cwd=self.upstream_work)
        self.git("push", "origin", "main", cwd=self.upstream_work)
        return self.rev(self.upstream_work)

    def run_sync(self, mode, *, force=False, expected=None):
        self.output.write_text("")
        self.summary.write_text("")
        env = os.environ.copy()
        env.update(
            {
                "GITHUB_OUTPUT": str(self.output),
                "GITHUB_STEP_SUMMARY": str(self.summary),
                "GIT_ALLOW_PROTOCOL": "file",
                "GIT_TERMINAL_PROMPT": "0",
            }
        )
        if force:
            env["FORCE_VALIDATION"] = "true"
        else:
            env.pop("FORCE_VALIDATION", None)
        if expected is not None:
            env["EXPECTED_FEATURE_HEAD"] = expected
        else:
            env.pop("EXPECTED_FEATURE_HEAD", None)
        return subprocess.run(
            ["bash", str(SCRIPT), mode],
            cwd=self.runner,
            env=env,
            text=True,
            capture_output=True,
        )

    def outputs(self):
        return dict(line.split("=", 1) for line in self.output.read_text().splitlines())

    def assert_succeeded(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_prepare_updates_mirror_without_publishing_feature(self):
        upstream_head = self.advance_upstream()

        result = self.run_sync("prepare")

        self.assert_succeeded(result)
        self.assertEqual(self.remote_rev("main"), upstream_head)
        self.assertEqual(self.remote_rev(FEATURE), self.feature_head)
        self.assertEqual(
            self.outputs(), {"feature_head": self.feature_head, "validate": "true"}
        )
        source = json.loads((self.runner / ".github/fork-source.json").read_text())
        self.assertEqual(
            source, {"upstreamRevision": upstream_head, "version": "1.1.0"}
        )

    def test_publish_advances_feature_from_expected_head(self):
        self.advance_upstream()
        self.assert_succeeded(self.run_sync("prepare"))
        validated_head = self.rev(self.runner)

        result = self.run_sync("publish", expected=self.feature_head)

        self.assert_succeeded(result)
        self.assertEqual(self.remote_rev(FEATURE), validated_head)
        self.assertIn(validated_head, self.summary.read_text())

    def test_conflict_leaves_published_feature_unchanged(self):
        (self.source / "shared.txt").write_text("feature version\n")
        self.git("add", "shared.txt", cwd=self.source)
        self.git("commit", "-m", "feature conflict", cwd=self.source)
        self.git("push", "origin", FEATURE, cwd=self.source)
        feature_head = self.rev(self.source)
        self.git("fetch", "origin", FEATURE, cwd=self.runner)
        self.git("reset", "--hard", f"origin/{FEATURE}", cwd=self.runner)
        upstream_head = self.advance_upstream("shared.txt", "upstream version\n")

        result = self.run_sync("prepare")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.remote_rev("main"), upstream_head)
        self.assertEqual(self.remote_rev(FEATURE), feature_head)

    def test_racing_feature_tip_blocks_publish(self):
        self.advance_upstream()
        self.assert_succeeded(self.run_sync("prepare"))
        validated_head = self.rev(self.runner)
        racer = self.root / "racer"
        self.git("clone", "--branch", FEATURE, str(self.origin), str(racer))
        self.configure_identity(racer)
        (racer / "race.txt").write_text("racing update\n")
        self.git("add", "race.txt", cwd=racer)
        self.git("commit", "-m", "race", cwd=racer)
        racing_head = self.rev(racer)
        hooks = self.root / "hooks"
        hooks.mkdir()
        pre_push = hooks / "pre-push"
        pre_push.write_text(
            "#!/usr/bin/env bash\n"
            f"git -C {racer} push origin {FEATURE}\n"
        )
        pre_push.chmod(0o755)
        self.git("config", "core.hooksPath", str(hooks), cwd=self.runner)

        result = self.run_sync("publish", expected=self.feature_head)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.remote_rev(FEATURE), racing_head)
        self.assertEqual(self.rev(self.runner), validated_head)

    def test_divergent_main_refuses_overwrite(self):
        self.advance_upstream()
        fork_main = self.root / "fork-main"
        self.git("clone", "--branch", "main", str(self.origin), str(fork_main))
        self.configure_identity(fork_main)
        (fork_main / "fork-main.txt").write_text("fork-only main commit\n")
        self.git("add", "fork-main.txt", cwd=fork_main)
        self.git("commit", "-m", "diverge fork main", cwd=fork_main)
        self.git("push", "origin", "main", cwd=fork_main)
        divergent_head = self.rev(fork_main)

        result = self.run_sync("prepare")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.remote_rev("main"), divergent_head)
        self.assertEqual(self.remote_rev(FEATURE), self.feature_head)
        self.assertEqual(self.output.read_text(), "")

    def test_up_to_date_skips_unless_forced(self):
        result = self.run_sync("prepare")

        self.assert_succeeded(result)
        self.assertEqual(
            self.outputs(), {"feature_head": self.feature_head, "validate": "false"}
        )
        self.assertEqual(self.rev(self.runner), self.feature_head)
        self.assertFalse((self.runner / ".github/fork-source.json").exists())

        forced = self.run_sync("prepare", force=True)

        self.assert_succeeded(forced)
        self.assertEqual(
            self.outputs(), {"feature_head": self.feature_head, "validate": "true"}
        )
        self.assertEqual(self.remote_rev(FEATURE), self.feature_head)
        source = json.loads((self.runner / ".github/fork-source.json").read_text())
        self.assertEqual(source["upstreamRevision"], self.base)


if __name__ == "__main__":
    unittest.main()
