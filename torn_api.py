"""Shared helper: talk to the Torn API politely (standard library only).

Every script uses this so the rules live in ONE place:
  * the key is never stored in a file (hidden prompt, --key, or TORN_API_KEY)
  * about one call every 2 seconds (Torn allows 100 per minute per key)
  * retry with growing waits on "too many requests", 429, 5xx and timeouts
"""
import getpass
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.torn.com/v2"
PAUSE = 2.0  # seconds between calls
_last_call = 0.0


class TornError(Exception):
    def __init__(self, code, message):
        super().__init__(f"Torn error {code}: {message}")
        self.code = code


def get_key(cli_key=None, label="Torn API key"):
    """Key from --key, then TORN_API_KEY, then a hidden prompt."""
    key = cli_key or os.environ.get("TORN_API_KEY")
    if not key:
        key = getpass.getpass(f"{label} (typing is hidden): ")
    return key.strip()


def call(path, key, params=None, tries=6):
    """GET one Torn API v2 path and return the parsed JSON."""
    global _last_call
    query = dict(params or {})
    query["key"] = key
    url = f"{BASE}{path}?{urllib.parse.urlencode(query)}"
    wait = 5
    for attempt in range(1, tries + 1):
        # pace ourselves
        gap = time.time() - _last_call
        if gap < PAUSE:
            time.sleep(PAUSE - gap)
        _last_call = time.time()
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                print(f"  HTTP {e.code}, waiting {wait}s then retrying...")
                time.sleep(wait)
                wait = min(wait * 2, 60)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            print(f"  network trouble ({e}), waiting {wait}s then retrying...")
            time.sleep(wait)
            wait = min(wait * 2, 60)
            continue
        err = data.get("error") if isinstance(data, dict) else None
        if err:
            code = err.get("code")
            if code == 5:  # too many requests
                print(f"  Torn says slow down, waiting {wait}s...")
                time.sleep(wait)
                wait = min(wait * 2, 60)
                continue
            raise TornError(code, err.get("error", "unknown"))
        return data
    raise RuntimeError(f"Gave up on {path} after {tries} tries")
