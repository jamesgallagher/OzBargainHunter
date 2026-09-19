#!/usr/bin/env python3
"""Derive the handful of response fixtures the live captures could not supply.

Every file this writes is a minimal, documented mutation of a real capture, or
a byte-exact reproduction of a response recorded in `research.md`. The raw
captures in `fixtures/http/` are never modified.

Usage:
    python3 fixtures/tools/derive_fixtures.py

Writes into fixtures/http/derived/.
"""

from __future__ import annotations

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
HTTP = ROOT / "fixtures" / "http"
OUT = HTTP / "derived"


def write(name: str, data: bytes) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_bytes(data)
    print(f"wrote fixtures/http/derived/{name} ({len(data)} bytes)")


def unpinned_freebie() -> None:
    """The only Freebie in the live capture is pinned and dated 2023, so the
    corpus cannot exercise the positive freebie path. Retype listing 975712
    (Selling, unpinned, relative timestamp, priced) as a Freebie. Nothing else
    on the page changes."""
    page = HTTP.joinpath("classifieds-page.html").read_text(encoding="utf-8")
    start = page.index('id="title975712"')
    end = page.index('id="title975710"')
    block = page[start:end]
    retyped = (
        block.replace('classified-type-tag sell"', 'classified-type-tag free"')
        .replace('href="/classified/sell"', 'href="/classified/free"')
        .replace('fa fa-fw fa-legal', 'fa fa-fw fa-gift')
        .replace(">Selling</a>", ">Freebie</a>")
    )
    assert retyped != block, "freebie retype matched nothing"
    write(
        "classifieds-page-unpinned-freebie.html",
        (page[:start] + retyped + page[end:]).encode("utf-8"),
    )


def anonymous_session() -> None:
    """The same page as served to a logged-out client: OzB_vars.uid drops to 0.
    This is the authoritative expired-session signal (design 3.6)."""
    page = HTTP.joinpath("classifieds-page.html").read_text(encoding="utf-8")
    anon = page.replace('"uid":226301', '"uid":0', 1)
    assert anon != page, "uid replacement matched nothing"
    write("classifieds-page-anon.html", anon.encode("utf-8"))


def cloudflare_block() -> None:
    """Byte-exact reproduction of the Cloudflare 1010 body recorded in
    research.md section 2.2: HTTP 403, 17 bytes, server: cloudflare."""
    write("cloudflare-1010.txt", b"error code: 1010\n")


def truncated_feed() -> None:
    """A 200 response whose body is not well-formed XML: r0.xml cut inside the
    third <item>. Exercises the '200 with unparseable XML' class."""
    raw = HTTP.joinpath("r0.xml").read_bytes()
    cut = raw.index(b"<guid isPermaLink=\"false\">975709")
    write("deals-page0-truncated.xml", raw[:cut])


def promoted_front_item() -> None:
    """No node in the front-page capture is absent from deals pages 0-1, so the
    corpus cannot exercise D43 (a deal reaching the front page without ever
    appearing on pages 0-1). Splice item 975122, captured four days deep at
    page 9, verbatim into the front-page feed."""
    front = HTTP.joinpath("cmp_front.xml").read_text(encoding="utf-8")
    deep = HTTP.joinpath("pg9.xml").read_text(encoding="utf-8")
    match = re.search(
        r"<item>(?:(?!</item>).)*?975122 at https://www\.ozbargain\.com\.au</guid>\s*</item>",
        deep,
        re.S,
    )
    assert match, "item 975122 not found in pg9.xml"
    spliced = front.replace("<item>", match.group(0) + "\n<item>", 1)
    write("front-feed-promoted.xml", spliced.encode("utf-8"))


if __name__ == "__main__":
    unpinned_freebie()
    anonymous_session()
    cloudflare_block()
    truncated_feed()
    promoted_front_item()
