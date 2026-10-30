"""Convert Google Maps saved-list CSVs (from Google Takeout) into a Svampkartan import file.

Usage:  python3 scripts/import_google_lists.py ~/Downloads/shrooms
Writes private/google-maps-spots.json, which you load with "Import JSON" in the app.
The private/ folder is git-ignored so your spots never reach the public repository.

Each CSV is one list; the list's file name decides the species. Only rows whose link holds
coordinates (dropped pins) are converted. Google does not export dates, so spots get none.
"""
import csv
import hashlib
import json
import pathlib
import re
import sys

# Google list name (lower case) -> app species id. Unknown list names become custom species.
LIST_SPECIES = {
    "kantarell": "kantarell",
    "kantareller": "kantarell",
    "trattkantarell": "trattkantarell",
    "trattkantareller": "trattkantarell",
    "svart trumpetsvamp": "svart-trumpetsvamp",
    "karljohan": "karljohan",
    "taggsvamp": "blek-taggsvamp",
    "blek taggsvamp": "blek-taggsvamp",
    "blomkålssvamp": "blomkalssvamp",
}
SPECIES_NAMES = {
    "kantarell": "Kantarell",
    "trattkantarell": "Trattkantarell",
    "svart-trumpetsvamp": "Svart trumpetsvamp",
    "karljohan": "Karljohan",
    "blek-taggsvamp": "Blek taggsvamp",
    "blomkalssvamp": "Blomkålssvamp",
}
COORDS = re.compile(r"/maps/search/(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)")
OUT = pathlib.Path(__file__).resolve().parent.parent / "private" / "google-maps-spots.json"


def read_rows(path):
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    # Some exports put the list name on a line above the header.
    start = next(i for i, line in enumerate(lines) if line.startswith("Title,Note,URL"))
    return [r for r in csv.DictReader(lines[start:]) if any((v or "").strip() for v in r.values())]


def main(folder):
    spots, skipped, seen = [], [], set()
    for path in sorted(pathlib.Path(folder).expanduser().glob("*.csv")):
        list_name = path.stem
        sid = LIST_SPECIES.get(list_name.lower(), "custom:" + list_name.lower())
        name = SPECIES_NAMES.get(sid, list_name)
        for row in read_rows(path):
            m = COORDS.search(row.get("URL") or "")
            if not m:
                skipped.append(f"{list_name}: {row.get('Title') or row.get('URL')}")
                continue
            lat, lon = round(float(m[1]), 6), round(float(m[2]), 6)
            key = (sid, lat, lon)
            if key in seen:
                continue
            seen.add(key)
            notes = "; ".join(v.strip() for v in (row.get("Note"), row.get("Comment")) if v and v.strip())
            spots.append({
                # Stable id, so importing the same file twice does not create duplicates.
                "id": "gmaps-" + hashlib.sha1(f"{sid}|{lat}|{lon}".encode()).hexdigest()[:16],
                "lat": lat, "lon": lon,
                "speciesId": sid, "species": name,
                "date": "",
                "notes": notes,
                "source": f"Google Maps list “{list_name}”",
            })

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"spots": spots}, ensure_ascii=False, indent=2))
    counts = {}
    for s in spots:
        counts[s["species"]] = counts.get(s["species"], 0) + 1
    for k, v in sorted(counts.items()):
        print(f"{k}: {v}")
    print(f"Wrote {len(spots)} spots to {OUT}")
    if skipped:
        print("Skipped (no coordinates in link):")
        for s in skipped:
            print("  " + s)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "~/Downloads/shrooms")
