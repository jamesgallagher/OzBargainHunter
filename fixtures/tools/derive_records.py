#!/usr/bin/env python3
"""Derive the canonical record-level fixtures from the raw captures.

This is provenance tooling, not application code. It exists so that
`fixtures/records/*.json` can be regenerated and audited rather than trusted.

The rules implemented here ARE the parser contract stated in `cards.json`
(card `acquisition`). If this script and the built parser disagree, one of
them is wrong and the disagreement is the bug.

Usage:
    python3 fixtures/tools/derive_records.py

Writes:
    fixtures/records/front-feed.json      <- fixtures/http/cmp_front.xml
    fixtures/records/deals-page0.json     <- fixtures/http/r0.xml
    fixtures/records/classifieds.json     <- fixtures/http/classifieds-page.html
"""

from __future__ import annotations

import html
import json
import pathlib
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parents[2]
HTTP = ROOT / "fixtures" / "http"
OUT = ROOT / "fixtures" / "records"

NS = {"ozb": "https://www.ozbargain.com.au", "dc": "http://purl.org/dc/elements/1.1/"}

MELBOURNE = ZoneInfo("Australia/Melbourne")

# The frozen clock for the whole fixture corpus. Relative classifieds
# timestamps ("1 hour 41 min ago") are resolved against this instant.
# Lower bound is forced by the corpus itself: listing 975632 reads
# "21 hours 38 min ago" and must still be newer than listing 975621,
# whose absolute stamp is 18/09/2026 - 18:23 AEST (2026-09-18T08:23Z),
# so FIXTURE_NOW must be later than 2026-09-19T06:01Z.
FIXTURE_NOW = datetime(2026, 9, 19, 6, 20, 0, tzinfo=timezone.utc)

CATEGORY_KINDS = ("cat", "tag", "brand", "product")


def utc(value: str | None) -> str | None:
    """Normalise an ISO-8601 stamp carrying an offset to UTC, 'Z'-suffixed."""
    if not value:
        return None
    return datetime.fromisoformat(value).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_rfc822(value: str) -> str:
    """Normalise an RFC-822 pubDate ('Sat, 19 Sep 2026 17:25:16 +1000') to UTC."""
    parsed = datetime.strptime(value.strip(), "%a, %d %b %Y %H:%M:%S %z")
    return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def categories(item: ET.Element) -> list[dict]:
    out = []
    for element in item.findall("category"):
        domain = element.get("domain") or ""
        match = re.search(r"/(" + "|".join(CATEGORY_KINDS) + r")/([^/]+)$", domain)
        if not match:
            continue
        out.append({"kind": match.group(1), "slug": match.group(2), "label": element.text or ""})
    return out


def deal_records(path: pathlib.Path) -> list[dict]:
    out = []
    for item in ET.parse(path).findall(".//item"):
        meta = item.find("ozb:meta", NS)
        guid = item.find("guid").text or ""
        out.append(
            {
                "node_id": int(guid.split(" ", 1)[0]),
                "title": item.find("title").text or "",
                "url": item.find("link").text or "",
                "author": (item.find("dc:creator", NS).text or "") if item.find("dc:creator", NS) is not None else None,
                "posted_at": utc_rfc822(item.find("pubDate").text or ""),
                "expiry_at": utc(meta.get("expiry")),
                "merchant_url": meta.get("url"),
                "goto_url": meta.get("link"),
                "image_url": meta.get("image"),
                "votes_pos": int(meta.get("votes-pos")),
                "votes_neg": int(meta.get("votes-neg")),
                "comment_count": int(meta.get("comment-count")),
                "click_count": int(meta.get("click-count")),
                "categories": categories(item),
                "description_html": item.find("description").text or "",
            }
        )
    return out


LISTING_SPLIT = re.compile(r'(?=<div class="node node-classified node-teaser")')
RE_NODE_ID = re.compile(r'<h2 class="title" id="title(\d+)"')
RE_DATA_TITLE = re.compile(r'<h2 class="title"[^>]*\sdata-title="([^"]*)"')
RE_TYPE = re.compile(r'<div class="classified-type-tag ([a-z]+)"')
RE_USER = re.compile(r'<a href="/user/(\d+)"[^>]*>([^<]*)</a>')
RE_ABS_TS = re.compile(r"\son (\d{2})/(\d{2})/(\d{4}) - (\d{2}):(\d{2})")
RE_REL_TS = re.compile(r"</strong>\s*((?:\d+\s+\w+\s+)+)ago")
RE_PRICE = re.compile(r'<span class="price">\s*([^<]*?)\s*(?:<em>|</span>)', re.S)
RE_SHIPPING = re.compile(r'<span title="shipping">\s*([^<]*?)\s*</span>')
RE_THUMB = re.compile(r'<div class="right">.*?<img src="([^"]+)"', re.S)
RE_LEADING_TAGS = re.compile(r"^\s*(?:\[([^\]]*)\]\s*)+")
RE_ONE_TAG = re.compile(r"\[([^\]]*)\]")

UNIT_SECONDS = {
    "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "hour": 3600, "hours": 3600,
    "day": 86400, "days": 86400,
    "week": 604800, "weeks": 604800,
}


def melbourne_to_utc(day: int, month: int, year: int, hour: int, minute: int) -> str:
    local = datetime(year, month, day, hour, minute, tzinfo=MELBOURNE)
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def relative_to_utc(phrase: str) -> str:
    seconds = 0
    for count, unit in re.findall(r"(\d+)\s+([a-z]+)", phrase):
        seconds += int(count) * UNIT_SECONDS[unit]
    return (FIXTURE_NOW - timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def listing_records(path: pathlib.Path) -> list[dict]:
    page = path.read_text(encoding="utf-8")
    out = []
    for block in LISTING_SPLIT.split(page)[1:]:
        node_id = int(RE_NODE_ID.search(block).group(1))
        title = html.unescape(RE_DATA_TITLE.search(block).group(1))

        leading = RE_LEADING_TAGS.match(title)
        tags = RE_ONE_TAG.findall(leading.group(0)) if leading else []

        user = RE_USER.search(block)
        poster = user.group(2) if user else None
        poster_id = int(user.group(1)) if user else None
        # OzBargain renders a live /user/ link whose visible text is the literal
        # string "No user info" when the poster is not shown. That is an absent
        # poster, not a user named "No user info".
        if poster == "No user info":
            poster, poster_id = None, None

        absolute = RE_ABS_TS.search(block)
        relative = RE_REL_TS.search(block)
        if absolute:
            posted_at = melbourne_to_utc(
                int(absolute.group(1)), int(absolute.group(2)), int(absolute.group(3)),
                int(absolute.group(4)), int(absolute.group(5)),
            )
            precision = "absolute"
        else:
            posted_at = relative_to_utc(relative.group(1))
            precision = "relative"

        price = RE_PRICE.search(block)
        shipping = RE_SHIPPING.search(block)
        thumb = RE_THUMB.search(block)

        out.append(
            {
                "node_id": node_id,
                "title": title,
                "url": f"https://www.ozbargain.com.au/node/{node_id}",
                "type": RE_TYPE.search(block).group(1),
                "pinned": "classified-sticky" in block,
                "category_tags": [html.unescape(t) for t in tags],
                "poster": poster,
                "poster_id": poster_id,
                "posted_at": posted_at,
                "posted_at_source": precision,
                "price": html.unescape(price.group(1)) if price and price.group(1) else None,
                "shipping": html.unescape(shipping.group(1)) if shipping else None,
                "thumbnail_url": thumb.group(1) if thumb else None,
            }
        )
    return out


def write(name: str, payload) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / name
    target.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {target.relative_to(ROOT)} ({len(payload['records'])} records)")


def main() -> None:
    write(
        "front-feed.json",
        {
            "source": "fixtures/http/cmp_front.xml",
            "surface": "front",
            "fixture_now": FIXTURE_NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "records": deal_records(HTTP / "cmp_front.xml"),
        },
    )
    write(
        "deals-page0.json",
        {
            "source": "fixtures/http/r0.xml",
            "surface": "deals",
            "fixture_now": FIXTURE_NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "records": deal_records(HTTP / "r0.xml"),
        },
    )
    write(
        "classifieds.json",
        {
            "source": "fixtures/http/classifieds-page.html",
            "surface": "classifieds",
            "fixture_now": FIXTURE_NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "records": listing_records(HTTP / "classifieds-page.html"),
        },
    )


if __name__ == "__main__":
    main()
