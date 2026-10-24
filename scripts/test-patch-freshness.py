#!/usr/bin/env python3
"""Regression checks for provenance auditing; no game install or Node deps needed."""

import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("audit-patch-freshness.py")
SPEC = importlib.util.spec_from_file_location("freshness", SCRIPT)
freshness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(freshness)


class FreshnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.now = datetime(2026, 4, 23, tzinfo=timezone.utc)
        for filename in freshness.CATALOGS.values():
            (self.data / filename).write_text('{"test": {"value": 1}}', encoding="utf-8")
        freshness.record(self.data, list(freshness.CATALOGS), "build-1", self.now)

    def audit(self, patch="build-1", now=None):
        return freshness.audit(self.data, patch, 30, now or self.now)

    def test_fresh_and_formatting_only_change(self):
        self.assertEqual(self.audit(), [])
        (self.data / freshness.CATALOGS["items"]).write_text(
            '{\n "test": { "value": 1 }\n}\n', encoding="utf-8")
        self.assertEqual(self.audit(), [])

    def test_each_catalog_changed_missing_and_invalid(self):
        for name, filename in freshness.CATALOGS.items():
            path = self.data / filename
            original = path.read_text()
            for content in ['{"changed": true}', '[]', '{', None]:
                with self.subTest(name=name, content=content):
                    if content is None:
                        path.unlink()
                    else:
                        path.write_text(content)
                    self.assertTrue(any(i.startswith(name + ":") for i in self.audit()))
                    path.write_text(original)

    def test_unknown_and_mismatched_patch(self):
        self.assertTrue(any("unknown" in i for i in self.audit(None)))
        self.assertEqual(sum("patch mismatch" in i for i in self.audit("build-2")), 4)
        freshness.record(self.data, ["items"], "build-2", self.now)
        self.assertTrue(any("mixed" in i for i in self.audit()))

    def test_age_boundary_and_future(self):
        self.assertEqual(self.audit(now=self.now + timedelta(days=30)), [])
        self.assertEqual(sum("stale" in i for i in self.audit(now=self.now + timedelta(days=31))), 4)
        self.assertEqual(sum("future" in i for i in self.audit(now=self.now - timedelta(seconds=1))), 4)

    def test_missing_and_malformed_metadata(self):
        path = self.data / freshness.MANIFEST
        path.unlink()
        self.assertEqual(sum("unverified" in i for i in self.audit()), 4)
        for content in ['{', '[]', '{"schemaVersion": 9, "catalogs": {}}']:
            path.write_text(content)
            self.assertTrue(any("manifest:" in i for i in self.audit()))
        path.write_text(json.dumps({"schemaVersion": 1, "catalogs": {
            "gods": {"patch": [], "verifiedAt": 42}, "items": "bad"}}))
        self.assertTrue(any("invalid verification date" in i for i in self.audit()))

    def test_dependency_change_survives_dependency_rerecord(self):
        for dep, consumer in [("effects", "gods"), ("gods", "timings")]:
            (self.data / freshness.CATALOGS[dep]).write_text('{"new": 2}')
            freshness.record(self.data, [dep], "build-1", self.now)
            self.assertTrue(any(i.startswith(f"{consumer}: {dep} dependency") for i in self.audit()))

    def test_record_batch_failure_does_not_change_manifest(self):
        path = self.data / freshness.MANIFEST
        before = path.read_bytes()
        (self.data / freshness.CATALOGS["items"]).unlink()
        with self.assertRaises(OSError):
            freshness.record(self.data, ["gods", "items"], "build-2", self.now)
        self.assertEqual(path.read_bytes(), before)

    def test_cli_report_strict_and_argument_errors(self):
        (self.data / freshness.MANIFEST).unlink()
        command = [sys.executable, str(SCRIPT), "--data-dir", str(self.data), "--json"]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertFalse(json.loads(result.stdout)["ok"])
        result = subprocess.run(command + ["--strict"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        for flags in [["--record", "gods"], ["--max-age-days", "-1"], ["--expected-patch", " "]]:
            self.assertEqual(subprocess.run(command + flags, capture_output=True).returncode, 2)
        result = subprocess.run(command + ["--record", *freshness.CATALOGS,
                                "--patch", "build-2", "--expected-patch", "build-2", "--strict"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
