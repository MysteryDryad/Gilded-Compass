"""STEP 2: save what TYPE each Torn item is (Plushie, Flower, ...) to item_types.json.

Uses one API call. Any key works (Key A or Key B).
"""
import argparse
import json

from torn_api import call, get_key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key")
    ap.add_argument("--out", default="item_types.json")
    args = ap.parse_args()
    key = get_key(args.key)

    data = call("/torn/items", key)
    items = data.get("items", data)
    items = items.values() if isinstance(items, dict) else items
    out = {}
    for it in items:
        out[str(it["id"])] = {
            "name": it.get("name"),
            "type": it.get("type"),
            "sub_type": it.get("sub_type"),
        }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    types = sorted({v["type"] for v in out.values() if v["type"]})
    print(f"Saved {len(out)} items to {args.out}")
    print("Types found:", ", ".join(types))
    for must in ("Plushie", "Flower"):
        print(f"  {must}: {'OK' if must in types else 'MISSING!'}")


if __name__ == "__main__":
    main()
