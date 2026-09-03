#!/usr/bin/env python3
"""Build the static Telegram-channel web site.

Reads Telegram discussion-group exports in source/<channel>/result.json,
extracts channel posts and their comments, produces _site/data.json, copies
media into _site/media/..., and copies the static UI (web/) into _site/.

Usage:
    python build.py [--out _site] [--no-fetch] [--clean]

--no-fetch  Do not hit the network for link previews; use the preview cache
            if present and fall back to domain-only cards otherwise.
"""
import argparse
import json
import os
import re
import shutil
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlsplit

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    requests = None
    BeautifulSoup = None

ROOT = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(ROOT, "source")
WEB = os.path.join(ROOT, "web")
CACHE = os.path.join(SOURCE, "previews_cache.json")
PAGE_SIZE = 20
UA = ("Mozilla/5.0 (compatible; shwars-channel-site/1.0; "
      "+https://github.com/shwars/channel)")

CHANNELS = [
    {"key": "cloud-advocate", "label": "Облачный адвокат",
     "dir": "cloud-advocate", "id": "channel1488671565", "prefix": "ca",
     "chat_id": "1439200994", "username": "shwarsico"},
    {"key": "curated-life", "label": "Курированная жизнь",
     "dir": "curated-life", "id": "channel2884425554", "prefix": "cl",
     "chat_id": "2661977113", "username": "curated_life"},
]

MEDIA_DIRS = ["photos", "video_files", "round_video_messages", "files", "stickers"]
RENDERABLE_STICKER_EXT = (".webp", ".png", ".jpg", ".jpeg", ".gif")
ALBUM_WINDOW = 3  # max seconds between grouped (album) media messages


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def escape(text):
    if text is None:
        return ""
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def short_url(url):
    try:
        parts = urlsplit(url)
        host = parts.netloc
        if host.startswith("www."):
            host = host[4:]
        path = (parts.path or "") + (("?" + parts.query) if parts.query else "")
        if len(path) > 70:
            path = path[:67] + "..."
        return host + path
    except Exception:
        return url


def render_entities(entities, fallback_text=None):
    """Render Telegram text_entities to safe HTML."""
    if not entities:
        return escape(fallback_text)
    out = []
    for ent in entities:
        if not isinstance(ent, dict):
            out.append(escape(ent))
            continue
        etype = ent.get("type", "plain")
        txt = escape(ent.get("text", ""))
        if etype == "plain":
            out.append(txt)
        elif etype == "bold":
            out.append("<strong>%s</strong>" % txt)
        elif etype == "italic":
            out.append("<em>%s</em>" % txt)
        elif etype == "underline":
            out.append("<u>%s</u>" % txt)
        elif etype == "strikethrough":
            out.append("<s>%s</s>" % txt)
        elif etype == "code":
            out.append("<code>%s</code>" % txt)
        elif etype == "pre":
            lang = ent.get("language") or ""
            cls = ""
            if lang:
                safe = re.sub(r"\W", "", lang)
                if safe:
                    cls = ' class="lang-%s"' % safe
            out.append("<pre%s>%s</pre>" % (cls, txt))
        elif etype == "blockquote":
            out.append("<blockquote>%s</blockquote>" % txt)
        elif etype == "spoiler":
            out.append('<span class="spoil">%s</span>' % txt)
        elif etype == "link":
            url = ent.get("text") or ""
            out.append('<a href="%s" rel="noopener" target="_blank">%s</a>'
                       % (escape(url), escape(short_url(url))))
        elif etype == "text_link":
            href = ent.get("href") or ent.get("text") or ""
            out.append('<a href="%s" rel="noopener" target="_blank">%s</a>'
                       % (escape(href), txt))
        elif etype == "mention":
            name = (ent.get("text") or "").lstrip("@")
            out.append('<a href="https://t.me/%s" rel="noopener" target="_blank">%s</a>'
                       % (escape(name), txt))
        elif etype == "mention_name":
            uid = ent.get("user_id", "")
            out.append('<a href="https://t.me/%s" rel="noopener" target="_blank">%s</a>'
                       % (escape(str(uid)), txt))
        elif etype == "email":
            out.append('<a href="mailto:%s">%s</a>' % (txt, txt))
        elif etype == "hashtag":
            out.append('<span class="htag">%s</span>' % txt)
        elif etype == "custom_emoji":
            out.append(txt)
        else:
            out.append(txt)
    return "".join(out)


def flat_text(message):
    text = message.get("text")
    if isinstance(text, str):
        return text
    if isinstance(text, list):
        parts = []
        for item in text:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text", "")))
        return "".join(parts)
    return ""


def media_href(channel_key, path):
    if not path:
        return None
    path = str(path).replace("\\", "/")
    first = path.split("/", 1)[0]
    if first in MEDIA_DIRS:
        return "media/%s/%s" % (channel_key, path)
    return path


def collect_links(message):
    urls = []
    for ent in message.get("text_entities") or []:
        etype = ent.get("type")
        if etype == "link":
            url = ent.get("text")
        elif etype == "text_link":
            url = ent.get("href")
        else:
            continue
        if url and url not in urls:
            urls.append(url)
    return urls


def media_items(message, channel_key):
    items = []
    photo = message.get("photo")
    if photo:
        items.append({"kind": "photo",
                      "src": media_href(channel_key, photo),
                      "w": message.get("width"),
                      "h": message.get("height")})
    media_type = message.get("media_type")
    file = message.get("file")
    if media_type in ("video_file", "video_message"):
        items.append({"kind": "video",
                      "src": media_href(channel_key, file),
                      "thumb": media_href(channel_key, message.get("thumbnail")),
                      "round": media_type == "video_message",
                      "w": message.get("width"),
                      "h": message.get("height"),
                      "dur": message.get("duration_seconds"),
                      "mime": message.get("mime_type"),
                      "name": message.get("file_name")})
    elif media_type == "audio_file":
        items.append({"kind": "audio",
                      "src": media_href(channel_key, file),
                      "name": message.get("file_name"),
                      "dur": message.get("duration_seconds"),
                      "mime": message.get("mime_type")})
    elif media_type == "sticker":
        if file and str(file).lower().endswith(RENDERABLE_STICKER_EXT):
            items.append({"kind": "sticker", "src": media_href(channel_key, file)})
    elif file and media_type not in ("video_file", "video_message", "audio_file", "sticker"):
        items.append({"kind": "file",
                      "src": media_href(channel_key, file),
                      "name": message.get("file_name") or os.path.basename(str(file)),
                      "size": message.get("file_size"),
                      "mime": message.get("mime_type")})
    return items


def reactions_list(message):
    out = []
    for r in message.get("reactions") or []:
        if r.get("type") == "emoji":
            out.append({"emoji": r.get("emoji", ""), "n": r.get("count", 1)})
    return out


def msg_record(message, channel, is_post):
    rec = {"from": message.get("from"),
           "date": message.get("date"),
           "ts": int(message.get("date_unixtime") or 0),
           "html": render_entities(message.get("text_entities"), flat_text(message)),
           "media": media_items(message, channel["key"]),
           "reactions": reactions_list(message)}
    if message.get("edited_unixtime"):
        rec["edited_ts"] = int(message["edited_unixtime"])
    fw_from = message.get("forwarded_from")
    fw_id = message.get("forwarded_from_id")
    if fw_from and fw_id != channel["id"]:
        rec["forwarded"] = fw_from
    if is_post:
        links = collect_links(message)
        if links:
            rec["links"] = links
    return rec


def root_post_id(message_id, by_id, post_ids, max_depth=60):
    cur = int(message_id)
    for _ in range(max_depth):
        if cur in post_ids:
            return cur
        msg = by_id.get(cur)
        if not msg:
            return None
        reply = msg.get("reply_to_message_id")
        if reply is None:
            return None
        cur = int(reply)
    return None


def has_media(message):
    return bool(message.get("photo")) or bool(message.get("file")) or bool(message.get("media_type"))


def has_text_content(message):
    entities = message.get("text_entities")
    if entities:
        return any(isinstance(e, dict) and (e.get("text") or "").strip() for e in entities)
    return bool(message.get("text"))


def group_albums(posts):
    """Group consecutive same-channel media messages into album cards."""
    groups = []
    i = 0
    n = len(posts)
    while i < n:
        cur = posts[i]
        if not has_media(cur):
            groups.append([cur])
            i += 1
            continue
        group = [cur]
        j = i + 1
        t0 = int(cur.get("date_unixtime") or 0)
        while j < n:
            nxt = posts[j]
            if int(nxt["id"]) != int(posts[j - 1]["id"]) + 1:
                break
            if not has_media(nxt):
                break
            if abs(int(nxt.get("date_unixtime") or 0) - t0) > ALBUM_WINDOW:
                break
            if has_text_content(nxt):
                break
            group.append(nxt)
            j += 1
        groups.append(group)
        i = j
    return groups


def build_channel(channel):
    export = load_json(os.path.join(SOURCE, channel["dir"], "result.json"))
    messages = export.get("messages", [])
    by_id = {}
    for m in messages:
        mid = m.get("id")
        if mid is not None:
            by_id[int(mid)] = m

    post_ids = {int(m["id"]) for m in messages
                if m.get("type") == "message" and m.get("from_id") == channel["id"]}

    threads = defaultdict(list)
    for m in messages:
        if m.get("type") != "message":
            continue
        if m.get("from_id") == channel["id"]:
            continue
        mid = int(m["id"])
        root = root_post_id(mid, by_id, post_ids)
        if root is not None:
            threads[root].append(m)

    post_msgs = [m for m in messages
                 if m.get("type") == "message" and m.get("from_id") == channel["id"]]
    post_msgs.sort(key=lambda m: int(m["id"]))

    records = []
    for group in group_albums(post_msgs):
        first = group[0]
        mid = int(first["id"])
        rec = msg_record(first, channel, is_post=True)
        rec["key"] = "%s-%d" % (channel["key"], mid)
        rec["channel"] = channel["key"]
        rec["id"] = "%s%d" % (channel["prefix"], mid)
        rec["tg"] = "https://t.me/%s/%d" % (channel["username"], mid)

        all_media = []
        for g in group:
            all_media.extend(media_items(g, channel["key"]))
        rec["media"] = all_media

        comments = []
        seen = set()
        for g in group:
            for c in threads.get(int(g["id"]), []):
                if int(c["id"]) not in seen:
                    seen.add(int(c["id"]))
                    comments.append(c)
        comments.sort(key=lambda c: int(c.get("date_unixtime") or 0))
        cmap = {}
        comment_records = []
        for c in comments:
            crec = msg_record(c, channel, is_post=False)
            crec["key"] = "%s-c%d" % (channel["key"], int(c["id"]))
            cmap[int(c["id"])] = crec
            comment_records.append(crec)
        for c in comments:
            reply = c.get("reply_to_message_id")
            if reply is not None and int(reply) in cmap:
                cmap[int(c["id"])]["reply_to"] = cmap[int(reply)]["key"]

        rec["comments_n"] = len(comment_records)
        rec["comments"] = comment_records
        records.append(rec)

    return export.get("name"), records


def domain_of(url):
    try:
        return urlsplit(url).netloc or url
    except Exception:
        return url


def load_cache():
    if os.path.exists(CACHE):
        try:
            with open(CACHE, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return {}
    return {}


def save_cache(cache):
    tmp = CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cache, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, CACHE)


def meta_content(soup, *names):
    for name in names:
        tag = soup.find("meta", attrs={"property": name}) or soup.find(
            "meta", attrs={"name": name})
        if tag and tag.get("content"):
            return str(tag["content"])
    return None


def fetch_preview(url, session):
    base = {"url": url, "domain": domain_of(url), "ok": False}
    try:
        resp = session.get(url, timeout=12, headers={"User-Agent": UA})
        resp.raise_for_status()
        ctype = resp.headers.get("content-type", "")
        if "text/html" not in ctype and "application/xhtml" not in ctype:
            return base
        soup = BeautifulSoup(resp.text, "html.parser")
        title = meta_content(soup, "og:title", "twitter:title") or (
            soup.title.string.strip() if soup.title and soup.title.string else None)
        desc = meta_content(soup, "og:description", "twitter:description", "description")
        image = meta_content(soup, "og:image", "twitter:image")
        if not title and not desc and not image:
            return base
        rec = {"url": url, "domain": domain_of(url), "ok": True}
        if title:
            rec["title"] = " ".join(title.split())
        if desc:
            rec["desc"] = " ".join(desc.split())
        if image:
            rec["image"] = image
        return rec
    except Exception:
        return base


def fetch_previews(urls, cache, no_fetch):
    missing = [u for u in urls if u not in cache]
    if missing and not no_fetch and requests is not None:
        session = requests.Session()
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(fetch_preview, u, session): u for u in missing}
            for fut in as_completed(futures):
                try:
                    cache[futures[fut]] = fut.result()
                except Exception:
                    pass
        save_cache(cache)

    result = {}
    for u in urls:
        result[u] = cache.get(u) or {"url": u, "domain": domain_of(u), "ok": False}
    return result


def copy_media(channel, out_dir):
    src_dir = os.path.join(SOURCE, channel["dir"])
    dst_dir = os.path.join(out_dir, "media", channel["key"])
    os.makedirs(dst_dir, exist_ok=True)
    for sub in MEDIA_DIRS:
        src_sub = os.path.join(src_dir, sub)
        if os.path.isdir(src_sub):
            shutil.copytree(src_sub, os.path.join(dst_dir, sub), dirs_exist_ok=True)


def copy_web(out_dir):
    for name in ("index.html", "style.css", "app.js", "favicon.svg"):
        src = os.path.join(WEB, name)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(out_dir, name))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=os.path.join(ROOT, "_site"))
    parser.add_argument("--no-fetch", action="store_true")
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()

    out_dir = args.out
    if args.clean and os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    cache = load_cache()
    channels_meta = []
    posts = []
    preview_posts = []

    for ch in CHANNELS:
        print("Processing %s ..." % ch["dir"])
        copy_media(ch, out_dir)
        display_name, channel_posts = build_channel(ch)
        channels_meta.append({"key": ch["key"], "label": ch["label"],
                              "export_name": display_name})
        posts.extend(channel_posts)
        for p in channel_posts:
            if not p["media"] and p.get("links"):
                preview_posts.append((p["key"], p["links"]))

    need = set()
    for _, links in preview_posts:
        need.update(links)
    previews = fetch_previews(need, cache, args.no_fetch)

    by_key = {p["key"]: p for p in posts}
    for key, links in preview_posts:
        by_key[key]["previews"] = [previews[u] for u in links if u in previews]

    posts.sort(key=lambda p: p["ts"], reverse=True)

    data = {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "page_size": PAGE_SIZE,
            "channels": channels_meta,
            "posts": posts}
    with open(os.path.join(out_dir, "data.json"), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))

    copy_web(out_dir)

    total_posts = len(posts)
    total_comments = sum(p["comments_n"] for p in posts)
    print("Channels: %d" % len(channels_meta))
    for c in channels_meta:
        print("  - %s (%s)" % (c["label"], c["export_name"] or "?"))
    print("Posts: %d" % total_posts)
    print("Comments: %d" % total_comments)
    print("Link previews: %d posts" % sum(1 for p in posts if p.get("previews")))
    print("Output: %s" % out_dir)


if __name__ == "__main__":
    main()

