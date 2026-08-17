#!/usr/bin/env python3
"""G1b gate validator: the artifact file must exist, parse as JSON, and carry
a non-empty string "report" key. A real, discriminating check — an absent or
malformed artifact fails the gate."""
import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check_artifact.py <artifact-path>")
        return 2
    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as handle:
            doc = json.load(handle)
    except OSError as error:
        print(f"FAIL: cannot read {path}: {error}")
        return 1
    except json.JSONDecodeError as error:
        print(f"FAIL: {path} is not valid JSON: {error}")
        return 1
    report = doc.get("report") if isinstance(doc, dict) else None
    if not isinstance(report, str) or report.strip() == "":
        print(f"FAIL: {path} lacks a non-empty string 'report' key")
        return 1
    print(f"PASS: {path} report={report!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
