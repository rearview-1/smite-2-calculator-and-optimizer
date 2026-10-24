#!/usr/bin/env python3
"""Offline patch provenance audit; recording is an explicit maintainer attestation."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CATALOGS = {
    "gods": "gods-catalog.json",
    "items": "items-catalog.json",
    "effects": "effects-catalog.json",
    "timings": "ability-timings.json",
}
DEPENDENCIES = {"gods": ["effects"], "timings": ["gods"]}
MANIFEST = "catalog-provenance.json"


def digest(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not value:
        raise ValueError(f"{path.name}: expected a nonempty JSON object")
    # Ignore indentation, object order and checkout line endings.
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_manifest(data):
    path = data / MANIFEST
    if not path.exists():
        return {"schemaVersion": 1, "catalogs": {}}
    value = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(value, dict) or value.get("schemaVersion") != 1
            or not isinstance(value.get("catalogs"), dict)):
        raise ValueError("invalid provenance manifest (expected schemaVersion 1 and catalogs object)")
    return value


def record(data, names, patch, now):
    manifest = read_manifest(data)
    # Collect all entries before writing, so a missing catalog cannot partially record a batch.
    entries = {}
    for name in names:
        entries[name] = {
            "patch": patch,
            "verifiedAt": now.isoformat(),
            "sha256": digest(data / CATALOGS[name]),
            "dependencies": {
                dep: digest(data / CATALOGS[dep]) for dep in DEPENDENCIES.get(name, [])
            },
        }
    manifest["catalogs"].update(entries)
    path = data / MANIFEST
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def audit(data, expected_patch, max_age_days, now):
    issues = []
    try:
        manifest = read_manifest(data)
    except (OSError, ValueError) as error:
        issues.append(f"manifest: {error}")
        manifest = {"catalogs": {}}
    if not expected_patch:
        issues.append("target patch unknown: supply --expected-patch from a verified live build/patch")
    hashes = {}
    for name, filename in CATALOGS.items():
        try:
            hashes[name] = digest(data / filename)
        except (OSError, ValueError) as error:
            issues.append(f"{name}: missing/invalid catalog: {error}")
    patches = set()
    for name in CATALOGS:
        entry = manifest["catalogs"].get(name)
        if not isinstance(entry, dict):
            issues.append(f"{name}: unverified; rebuild/review and record provenance")
            continue
        patch = entry.get("patch")
        if not isinstance(patch, str) or not patch.strip():
            issues.append(f"{name}: missing patch ID")
        else:
            patches.add(patch)
            if expected_patch and patch != expected_patch:
                issues.append(f"{name}: patch mismatch: recorded {patch!r}, expected {expected_patch!r}")
        try:
            stamp = datetime.fromisoformat(entry.get("verifiedAt", "").replace("Z", "+00:00"))
            if stamp.utcoffset() is None:
                raise ValueError("timezone required")
            age = (now - stamp).total_seconds() / 86400
            if age < 0:
                issues.append(f"{name}: verification date is in the future")
            elif age > max_age_days:
                issues.append(f"{name}: stale verification ({age:.1f} days; limit {max_age_days})")
        except (ValueError, TypeError, AttributeError):
            issues.append(f"{name}: missing/invalid verification date")
        if name in hashes and entry.get("sha256") != hashes[name]:
            issues.append(f"{name}: content mismatch since verification")
        deps = entry.get("dependencies")
        for dep in DEPENDENCIES.get(name, []):
            if not isinstance(deps, dict) or deps.get(dep) != hashes.get(dep) or dep not in hashes:
                issues.append(f"{name}: {dep} dependency changed or unverified; rebuild/review {name}")
    if len(patches) > 1:
        issues.append("mixed catalog patches: " + ", ".join(sorted(patches)))
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=REPO / "data")
    parser.add_argument("--expected-patch", help="exact live patch/build ID; no version ordering is assumed")
    parser.add_argument("--max-age-days", type=int, default=30)
    parser.add_argument("--strict", action="store_true", help="exit 1 on any finding (default: report only)")
    parser.add_argument("--json", action="store_true", help="emit a machine-readable report to stdout")
    parser.add_argument("--record", nargs="+", choices=list(CATALOGS), help="attest reviewed catalogs")
    parser.add_argument("--patch", help="patch/build ID for --record")
    args = parser.parse_args()
    if args.max_age_days < 0:
        parser.error("--max-age-days must be nonnegative")
    if args.expected_patch is not None and not args.expected_patch.strip():
        parser.error("--expected-patch cannot be blank")
    if args.record and (not args.patch or not args.patch.strip()):
        parser.error("--record requires a nonblank --patch")
    if args.patch and not args.record:
        parser.error("--patch requires --record")
    now = datetime.now(timezone.utc)
    if args.record:
        try:
            record(args.data_dir, args.record, args.patch, now)
        except (OSError, ValueError) as error:
            parser.error(str(error))
    issues = audit(args.data_dir, args.expected_patch, args.max_age_days, now)
    report = {"expectedPatch": args.expected_patch, "maxAgeDays": args.max_age_days,
              "ok": not issues, "issues": issues}
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("=== Catalog patch freshness ===")
        print(f"Catalogs: {len(CATALOGS)} | Findings: {len(issues)}")
        for issue in issues:
            print(f"  - {issue}")
        if not issues:
            print("Catalog provenance matches the supplied patch and verification-age policy.")
    return 1 if args.strict and issues else 0


if __name__ == "__main__":
    raise SystemExit(main())
