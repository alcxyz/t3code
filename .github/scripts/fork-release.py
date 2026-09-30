#!/usr/bin/env python3
"""Select an actual published upstream release, never a moving branch."""

import json
import os
import re
import subprocess
import sys


def api(path):
    return json.loads(subprocess.check_output(
        ["gh", "api", f"repos/pingdotgg/t3code/{path}"], text=True
    ))


def select(channel, releases):
    if channel == "stable":
        pattern = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+$")
    elif channel == "nightly":
        pattern = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$")
    else:
        raise ValueError("channel must be stable or nightly")
    matches = [r for r in releases if not r.get("draft")
               and r.get("prerelease") is (channel == "nightly")
               and r.get("published_at") and pattern.fullmatch(r.get("tag_name", ""))]
    if not matches:
        raise ValueError(f"No published {channel} release found")
    tag = max(matches, key=lambda r: (r["published_at"], r["tag_name"]))["tag_name"]
    return tag, tag[1:]


def main():
    channel = sys.argv[1]
    fixture = os.environ.get("FORK_RELEASES_JSON_FILE")
    if fixture:
        with open(fixture, encoding="utf-8") as source:
            releases = json.load(source)
    elif channel == "stable":
        releases = [api("releases/latest")]
    else:
        releases = api("releases?per_page=100")
    print(*select(channel, releases))


if __name__ == "__main__":
    main()
