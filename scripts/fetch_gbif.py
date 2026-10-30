"""One-time snapshot of GBIF records in Sweden for a set of edible mushrooms.

Writes data/gbif_species.js, which the map loads as static seed data.
Run again only if you want a fresh snapshot:  python3 scripts/fetch_gbif.py
"""
import json
import pathlib
import subprocess
import urllib.parse

# id, Swedish name, scientific name, GBIF backbone taxon key
SPECIES = [
    ("kantarell", "Kantarell", "Cantharellus cibarius", 5249504),
    ("trattkantarell", "Trattkantarell", "Craterellus tubaeformis", 2554536),
    ("svart-trumpetsvamp", "Svart trumpetsvamp", "Craterellus cornucopioides", 2554662),
    ("karljohan", "Karljohan", "Boletus edulis", 5954958),
    ("blek-taggsvamp", "Blek taggsvamp", "Hydnum repandum", 2554716),
]
PAGE = 300
# GBIF stalls when paging past ~10,000 results, so year ranges are split until each is below this.
# (Records with no year are not reachable this way; it is a few dozen per species.)
MAX_SLICE = 9000
FIRST_YEAR, LAST_YEAR = 1800, 2100
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "gbif_species.js"


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


result = []
for sid, name, scientific, taxon_key in SPECIES:
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
                    o.get("coordinateUncertaintyInMeters"),
                ])
            offset += PAGE
            if page["endOfRecords"]:
                break
        print(f"{name} {years[0]}-{years[1]}: total {len(records)}")
    result.append({"id": sid, "name": name, "scientific": scientific, "taxonKey": taxon_key, "records": records})

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(
    "// GBIF snapshot of Swedish records. Record fields: lat, lon, date, gbifID, uncertainty (m)\n"
    "window.GBIF_SPECIES = " + json.dumps(result, separators=(",", ":")) + ";\n"
)
print(f"Wrote {sum(len(s['records']) for s in result)} records to {OUT}")
