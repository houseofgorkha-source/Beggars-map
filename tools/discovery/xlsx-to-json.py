#!/usr/bin/env python3
"""Read one sheet of an .xlsx workbook and print it as JSON on stdout.

Exists because the rest of this pipeline is Node, but there is no xlsx
reader in the Node dependency set and adding one would mean a new npm
dependency (which this repo installs awkwardly — see the --ignore-scripts
note in AGENTS.md). openpyxl is already a dependency of this directory
(build-reverification-workbook.py uses it), so this is the cheaper seam:
one tiny, dumb converter with no business logic in it at all.

Deliberately does no filtering, no type coercion and no column renaming —
every decision about which rows qualify lives in import-excel.mjs, so
there is exactly one place to audit that logic.

Usage: python xlsx-to-json.py <path-to-xlsx>
Output: {"headers": [...], "rows": [{header: value, ...}, ...]}
"""
import json
import sys

import openpyxl


def write_json(payload) -> None:
    # Write UTF-8 bytes straight to the raw stdout buffer rather than
    # through sys.stdout: on Windows the console encoding defaults to
    # cp1252, which raises UnicodeEncodeError on the non-Latin-1 bytes
    # this sheet genuinely contains (confirmed against the real file).
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: xlsx-to-json.py <path-to-xlsx>", file=sys.stderr)
        return 2

    workbook = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
    sheet = workbook.active

    rows_iter = sheet.iter_rows(values_only=True)
    try:
        headers = [("" if h is None else str(h)) for h in next(rows_iter)]
    except StopIteration:
        write_json({"headers": [], "rows": []})
        return 0

    rows = []
    for values in rows_iter:
        if all(v is None for v in values):
            continue
        row = {}
        for i, header in enumerate(headers):
            value = values[i] if i < len(values) else None
            # Excel hands back datetimes for some cells; JSON can't carry
            # those, and nothing downstream needs them as dates.
            row[header] = value if value is None or isinstance(value, (str, int, float, bool)) else str(value)
        rows.append(row)

    write_json({"headers": headers, "rows": rows})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
