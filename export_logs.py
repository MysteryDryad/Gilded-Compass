"""STEP 1: export your bazaar purchase logs to bazaar_logs.txt.

Run:  python export_logs.py            (asks for Key A, hidden)
      python export_logs.py --peek     (just show 3 raw entries, write nothing)
"""
import argparse
import datetime
import json

from torn_api import call, get_key


def find_log_ids(key):
    data = call("/torn/logtypes", key)
    types = data.get("logtypes", data)
    ids = []
    # logtypes may be a list of {id,title} or a dict id -> title
    items = types.items() if isinstance(types, dict) else (
        (t.get("id"), t.get("title")) for t in types)
    for log_id, title in items:
        if str(title).lower().startswith("bazaar buy"):
            ids.append(int(log_id))
            print(f"  using log type {log_id}: {title}")
    if not ids:
        raise SystemExit("Could not find any 'Bazaar buy' log types.")
    return ids


def entries_of(page):
    log = page.get("log", [])
    return list(log.values()) if isinstance(log, dict) else log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key")
    ap.add_argument("--out", default="bazaar_logs.txt")
    ap.add_argument("--peek", action="store_true")
    args = ap.parse_args()
    key = get_key(args.key, "Key A (personal logs)")

    print("Looking up the log type ids...")
    ids = ",".join(map(str, find_log_ids(key)))

    seen, rows, to = set(), [], None
    while True:
        params = {"log": ids, "limit": 100, "sort": "desc"}
        if to:
            params["to"] = to
        page = entries_of(call("/user/log", key, params))
        if args.peek:
            for e in page[:3]:
                print(json.dumps(e, indent=2))
            return
        new = 0
        for e in page:
            uid = e.get("id") or json.dumps(e, sort_keys=True)
            if uid in seen:
                continue
            seen.add(uid)
            rows.append(e)
            new += 1
        print(f"  fetched {len(rows)} purchases so far")
        if len(page) < 100 or new == 0:
            break
        to = min(e["timestamp"] for e in page)

    rows.sort(key=lambda e: e["timestamp"], reverse=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for e in rows:
            when = datetime.datetime.fromtimestamp(
                e["timestamp"], datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            title = e.get("title") or e.get("details", {}).get("title", "Bazaar buy")
            f.write(f"[{when}] {title}\n")
            f.write(f"    data:   {json.dumps(e.get('data', {}))}\n")
    if rows:
        newest = datetime.datetime.fromtimestamp(rows[0]["timestamp"], datetime.timezone.utc)
        oldest = datetime.datetime.fromtimestamp(rows[-1]["timestamp"], datetime.timezone.utc)
        print(f"Done: {len(rows)} purchases, {oldest:%Y-%m-%d} to {newest:%Y-%m-%d} -> {args.out}")
    else:
        print("No purchases found.")


if __name__ == "__main__":
    main()
