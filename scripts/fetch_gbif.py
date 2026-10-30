"""One-time snapshot of GBIF records in Sweden for a set of edible mushrooms.

Writes data/gbif_species.js, which the map loads as static seed data.
Run again only if you want a fresh snapshot:  python3 scripts/fetch_gbif.py
Fetch only some species and keep the rest of the file:  python3 scripts/fetch_gbif.py blomkalssvamp
"""
import json
import pathlib
import subprocess
import sys
import urllib.parse

# id, Swedish name, scientific name, GBIF backbone taxon key
SPECIES = [
    ("kantarell", "Kantarell", "Cantharellus cibarius", 5249504),
    ("trattkantarell", "Trattkantarell", "Craterellus tubaeformis", 2554536),
    ("svart-trumpetsvamp", "Svart trumpetsvamp", "Craterellus cornucopioides", 2554662),
    ("karljohan", "Karljohan", "Boletus edulis", 5954958),
    ("blek-taggsvamp", "Blek taggsvamp", "Hydnum repandum", 2554716),
    ("blomkalssvamp", "Blomkålssvamp", "Sparassis crispa", 2550247),
]
PAGE = 300
# GBIF stalls when paging past ~10,000 results, so year ranges are split until each is below this.
# (Records with no year are not reachable this way; it is a few dozen per species.)
MAX_SLICE = 9000
FIRST_YEAR, LAST_YEAR = 1800, 2100
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "gbif_species.js"


def write_js(result):
    for sp in result:
        for r in sp["records"]:
            if r[4] is not None:
                r[4] = round(r[4])
    # Wrapped in JSON.parse('…'): browsers parse a JSON string much faster than the same data as JS code.
    body = json.dumps(result, separators=(",", ":")).replace("\\", "\\\\").replace("'", "\\'")
    OUT.write_text(
        "// GBIF snapshot of Swedish records. Record fields: lat, lon, date, gbifID, uncertainty (m)\n"
        "window.GBIF_SPECIES = JSON.parse('" + body + "');\n"
    )


def read_js():
    text = OUT.read_text()
    start = text.index("=") + 1
    body = text[start:].strip().rstrip(";")
    if body.startswith("JSON.parse('"):
        body = body[len("JSON.parse('"):-len("')")].replace("\\'", "'").replace("\\\\", "\\")
    return json.loads(body)


def search(taxon_key, years, offset=0, limit=PAGE):
    params = urllib.parse.urlencode({
        "taxonKey": taxon_key,
        "country": "SE",
        "hasCoordinate": "true",
        "hasGeospatialIssue": "false",
        "occurrenceStatus": "PRESENT",
        "year": f"{years[0]},{years[1]}",
        "limit": limit,
        "offset": offset,
    })
    # curl with a hard per-request deadline: GBIF sometimes stalls mid-response.
    out = subprocess.run(
        ["curl", "-sf", "--max-time", "30", "--retry", "5", "--retry-all-errors", "--retry-delay", "3",
         f"https://api.gbif.org/v1/occurrence/search?{params}"],
        capture_output=True, check=True,
    ).stdout
    return json.loads(out)


def year_slices(taxon_key, years=(FIRST_YEAR, LAST_YEAR)):
    count = search(taxon_key, years, limit=0)["count"]
    if count <= MAX_SLICE or years[0] == years[1]:
        return [years] if count else []
    mid = (years[0] + years[1]) // 2
    return year_slices(taxon_key, (years[0], mid)) + year_slices(taxon_key, (mid + 1, years[1]))


only = set(sys.argv[1:])
unknown = only - {s[0] for s in SPECIES}
if unknown:
    sys.exit(f"Unknown species id(s): {', '.join(sorted(unknown))}")
existing = {}
if only and OUT.exists():
    existing = {s["id"]: s for s in read_js()}

result = []
for sid, name, scientific, taxon_key in SPECIES:
    if only and sid not in only:
        if sid in existing:
            result.append(existing[sid])
        continue
    records = []
    for years in year_slices(taxon_key):
        offset = 0
        while True:
            page = search(taxon_key, years, offset)
            for o in page["results"]:
                records.append([
                    round(o["decimalLatitude"], 5),
                    round(o["decimalLongitude"], 5),
                    (o.get("eventDate") or "")[:10],
                    o["key"],
                    round(o["coordinateUncertaintyInMeters"]) if o.get("coordinateUncertaintyInMeters") is not None else None,
                ])
            offset += PAGE
            if page["endOfRecords"]:
                break
        print(f"{name} {years[0]}-{years[1]}: total {len(records)}")
    result.append({"id": sid, "name": name, "scientific": scientific, "taxonKey": taxon_key, "records": records})

OUT.parent.mkdir(exist_ok=True)
write_js(result)
print(f"Wrote {sum(len(s['records']) for s in result)} records to {OUT}")
