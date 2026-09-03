(function () {
  "use strict";
  var FALLBACK_PAGE = 20;
  var data = null;
  var channelById = {};
  var state = { page: 0, filters: {}, query: "", focusId: null };

  var feed = document.getElementById("feed");
  var pager = document.getElementById("pager");
  var filtersEl = document.getElementById("filters");
  var statusEl = document.getElementById("status");
  var searchInput = document.getElementById("search");

  var LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

  function fmtDate(ts) {
    if (!ts) return "";
    return new Date(ts * 1000).toLocaleString("ru-RU", {
      day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }
  function fmtSize(n) {
    if (n == null) return "";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " МБ";
    if (n >= 1024) return Math.round(n / 1024) + " КБ";
    return String(n) + " Б";
  }
  function stripTags(html) {
    return (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  function snippet(html) {
    var t = stripTags(html);
    if (t.length > 70) t = t.slice(0, 67) + "…";
    return t;
  }
  function faviconUrl(domain) {
    return "https://www.google.com/s2/favicons?domain=" +
      encodeURIComponent(domain) + "&sz=64";
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderMedia(items) {
    if (!items || !items.length) return null;
    var box = el("div", items.length > 1 ? "media grid" : "media");
    items.forEach(function (m) {
      if (m.kind === "photo") {
        var img = document.createElement("img");
        img.className = "photo"; img.loading = "lazy"; img.src = m.src; img.alt = "";
        box.appendChild(img);
      } else if (m.kind === "video") {
        var v = document.createElement("video");
        v.controls = true; v.preload = "metadata";
        if (m.round) v.className = "round";
        if (m.thumb) v.poster = m.thumb;
        var src = document.createElement("source");
        src.src = m.src; src.type = m.mime || "video/mp4";
        v.appendChild(src);
        box.appendChild(v);
      } else if (m.kind === "audio") {
        var a = document.createElement("audio");
        a.controls = true; a.preload = "none";
        var src2 = document.createElement("source");
        src2.src = m.src; src2.type = m.mime || "audio/mpeg";
        a.appendChild(src2);
        box.appendChild(a);
      } else if (m.kind === "sticker") {
        var st = document.createElement("img");
        st.className = "sticker"; st.loading = "lazy"; st.src = m.src; st.alt = "";
        box.appendChild(st);
      } else if (m.kind === "file") {
        var link = document.createElement("a");
        link.className = "file-chip"; link.href = m.src; link.download = "";
        link.appendChild(el("span", "", "📄"));
        link.appendChild(el("span", "fname", m.name || ""));
        link.appendChild(el("span", "fsize", m.size != null ? fmtSize(m.size) : ""));
        box.appendChild(link);
      }
    });
    return box;
  }

  function renderPreview(pv) {
    if (!pv) return null;
    var card = el("div", "preview");
    var u = document.createElement("a");
    u.className = "pv-url"; u.href = pv.url; u.target = "_blank"; u.rel = "noopener";
    u.textContent = pv.url;

    if (pv.ok && (pv.image || pv.title)) {
      if (pv.image) {
        var img = document.createElement("img");
        img.className = "pv-img"; img.loading = "lazy"; img.src = pv.image;
        img.alt = ""; img.onerror = function () { img.remove(); };
        card.appendChild(img);
      }
      var body = el("div", "pv-body");
      body.appendChild(el("div", "pv-domain", pv.domain));
      if (pv.title) body.appendChild(el("div", "pv-title", pv.title));
      if (pv.desc) body.appendChild(el("div", "pv-desc", pv.desc));
      body.appendChild(u);
      card.appendChild(body);
    } else {
      card.classList.add("fallback");
      var fav = document.createElement("img");
      fav.className = "pv-fav"; fav.src = faviconUrl(pv.domain); fav.alt = "";
      fav.onerror = function () { fav.remove(); };
      card.appendChild(fav);
      var fb = el("div", "pv-body", pv.domain);
      fb.appendChild(u);
      card.appendChild(fb);
    }
    return card;
  }

  function renderReactions(reactions) {
    if (!reactions || !reactions.length) return null;
    var row = el("div", "reactions");
    reactions.forEach(function (r) {
      row.appendChild(el("span", "reaction", r.emoji + " " + r.n));
    });
    return row;
  }

  function buildCommentsList(post) {
    var wrap = el("div", "comments-list");
    var cmap = {};
    (post.comments || []).forEach(function (c) { cmap[c.key] = c; });
    post.comments.forEach(function (c) {
      var cc = el("div", "comment");
      var top = el("div", "comment-top");
      top.appendChild(el("span", "comment-from", c.from || "?"));
      top.appendChild(el("span", "comment-date", fmtDate(c.ts)));
      cc.appendChild(top);
      var text = el("div", "msg-text");
      text.innerHTML = c.html || "";
      cc.appendChild(text);
      if (c.reply_to && cmap[c.reply_to]) {
        cc.appendChild(el("div", "reply-hint",
          "→ " + (cmap[c.reply_to].from || "?") + ": " +
          snippet(cmap[c.reply_to].html)));
      }
      var m = renderMedia(c.media);
      if (m) {
        var wrap2 = el("div");
        wrap2.appendChild(m);
        cc.appendChild(wrap2);
      }
      wrap.appendChild(cc);
    });
    return wrap;
  }

  function renderComments(post, card) {
    var list = post.comments || [];
    if (post.comments_n <= 0 || list.length === 0) return null;
    var toggle = el("button", "comments-toggle");
    toggle.appendChild(el("span", "cicon", "▶"));
    toggle.appendChild(el("span", "clabel", "Комментарии · " + list.length));

    var listWrap = null;
    toggle.addEventListener("click", function () {
      var open = card.classList.toggle("open");
      if (open) {
        if (!listWrap) {
          listWrap = buildCommentsList(post);
          card.appendChild(listWrap);
        }
      } else {
        if (listWrap) { listWrap.remove(); listWrap = null; }
      }
    });
    return toggle;
  }

  function renderPermalink(post) {
    var a = document.createElement("a");
    a.className = "plink";
    a.href = "?id=" + encodeURIComponent(post.id);
    a.title = "Ссылка на пост";
    a.setAttribute("aria-label", "Ссылка на пост");
    a.innerHTML = LINK_ICON;
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      goToPost(post);
    });
    return a;
  }

  function buildCard(post) {
    var card = el("article", "card");
    card.id = "post-" + post.key;

    var head = el("div", "card-head");
    var ch = channelById[post.channel];
    head.appendChild(el("span", "ch-tag " + post.channel, ch ? ch.label : post.channel));
    head.appendChild(el("span", "card-date", fmtDate(post.ts)));
    if (post.edited_ts) head.appendChild(el("span", "edited", "(изм.)"));
    head.appendChild(renderPermalink(post));
    card.appendChild(head);

    var body = el("div", "card-body");
    var text = el("div", "msg-text");
    text.innerHTML = post.html || "";
    body.appendChild(text);
    var media = renderMedia(post.media);
    if (media) body.appendChild(media);
    if (post.previews && post.previews.length) {
      var pv = renderPreview(post.previews[0]);
      if (pv) body.appendChild(pv);
    }
    card.appendChild(body);

    var meta = el("div", "card-meta");
    if (post.forwarded) {
      meta.appendChild(el("span", "fwd", "Репост: "));
      meta.appendChild(el("span", "src", post.forwarded));
    }
    var rx = renderReactions(post.reactions);
    if (rx) meta.appendChild(rx);
    if (meta.childNodes.length) card.appendChild(meta);

    var ct = renderComments(post, card);
    if (ct) card.appendChild(ct);
    return card;
  }

  function pageWindow(total) {
    var cur = state.page + 1;
    if (total <= 9) {
      var all = [];
      for (var i = 1; i <= total; i++) all.push(i);
      return all;
    }
    var start = Math.max(1, cur - 3);
    var end = Math.min(total, cur + 3);
    var out = [];
    if (start > 1) out.push(1);
    if (start > 2) out.push("…");
    for (var i2 = start; i2 <= end; i2++) out.push(i2);
    if (end < total - 1) out.push("…");
    if (end < total) out.push(total);
    return out;
  }

  function renderPager(totalPages) {
    pager.textContent = "";
    if (totalPages <= 1) return;
    var nav = function (label, page, disabled) {
      var b = el("button", "nav", label);
      b.disabled = !!disabled;
      if (!disabled) b.addEventListener("click", function () { go(page, false); });
      pager.appendChild(b);
    };
    nav("←", state.page - 1, state.page === 0);
    pageWindow(totalPages).forEach(function (item) {
      if (item === "…") { pager.appendChild(el("span", "ell", "…")); return; }
      var b = el("button", "", String(item));
      if (item === state.page + 1) b.classList.add("active");
      b.addEventListener("click", function () { go(item - 1, false); });
      pager.appendChild(b);
    });
    nav("→", state.page + 1, state.page >= totalPages - 1);
  }

  // ---- routing (query params) ----

  function parseQuery() {
    var out = {};
    var s = location.search.replace(/^\?/, "");
    if (!s) return out;
    s.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
      else if (kv) out[kv] = "";
    });
    return out;
  }

  function buildQuery() {
    var parts = ["p=" + state.page];
    var c = data.channels.filter(function (ch) { return state.filters[ch.key]; })
      .map(function (ch) { return ch.key; }).join(",");
    parts.push("c=" + c);
    if (state.query) parts.push("q=" + encodeURIComponent(state.query));
    if (state.focusId) parts.push("id=" + encodeURIComponent(state.focusId));
    return parts.join("&");
  }

  function writeUrl(replace) {
    var url = location.pathname + "?" + buildQuery();
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }

  function channelFilteredPosts() {
    return data.posts.filter(function (p) { return state.filters[p.channel]; });
  }

  function allFilteredPosts() {
    var q = (state.query || "").toLowerCase().trim();
    return data.posts.filter(function (p) {
      if (!state.filters[p.channel]) return false;
      if (q && p._search.indexOf(q) < 0) return false;
      return true;
    });
  }

  function go(page, replace) {
    state.page = page;
    writeUrl(!!replace);
    renderFeed();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function focusCard(key) {
    var node = document.getElementById("post-" + key);
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.add("flash");
    setTimeout(function () { node.classList.remove("flash"); }, 2600);
  }

  function goToPost(post) {
    state.filters[post.channel] = true;
    state.focusId = post.id;
    var list = channelFilteredPosts();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === post.id) { state.page = Math.floor(i / data.page_size); break; }
    }
    writeUrl(false);
    renderFeed();
    focusCard(post.key);
  }

  function readStateFromUrl() {
    var q = parseQuery();
    var c = q.c;
    data.channels.forEach(function (ch) {
      state.filters[ch.key] = (c == null) ? true : (c.split(",").indexOf(ch.key) >= 0);
    });
    var p = parseInt(q.p, 10);
    state.page = (!isNaN(p) && p >= 0) ? p : 0;
    state.query = (q.q != null) ? q.q : "";
    state.focusId = (q.id != null) ? q.id : null;
  }

  function syncFromUrl() {
    readStateFromUrl();
    if (searchInput) searchInput.value = state.query;
    var focus = null;
    if (state.focusId) {
      data.posts.forEach(function (p) { if (p.id === state.focusId) focus = p; });
    }
    if (focus) {
      state.filters[focus.channel] = true;
      var list = channelFilteredPosts();
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === focus.id) { state.page = Math.floor(i / data.page_size); break; }
      }
    }
    renderFeed();
    if (focus) focusCard(focus.key);
  }

  function renderFeed() {
    var posts = allFilteredPosts();
    var totalPages = Math.max(1, Math.ceil(posts.length / data.page_size));
    if (state.page >= totalPages) state.page = totalPages - 1;
    var from = state.page * data.page_size;
    var slice = posts.slice(from, from + data.page_size);

    feed.textContent = "";
    slice.forEach(function (p) { feed.appendChild(buildCard(p)); });
    renderPager(totalPages);

    var countEl = document.getElementById("countNum");
    if (countEl) countEl.textContent = "Постов: " + posts.length;
  }

  function renderFilters() {
    filtersEl.textContent = "";
    data.channels.forEach(function (ch) {
      var lab = document.createElement("label");
      lab.className = "chk";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = state.filters[ch.key];
      cb.addEventListener("change", function () {
        state.filters[ch.key] = cb.checked;
        state.page = 0;
        state.focusId = null;
        writeUrl(true);
        renderFeed();
      });
      var dot = el("span", "dot dot-" + (ch.key === "cloud-advocate" ? "ca" : "cl"));
      lab.appendChild(cb);
      lab.appendChild(dot);
      lab.appendChild(document.createTextNode(ch.label));
      filtersEl.appendChild(lab);
    });
    filtersEl.appendChild(el("span", "count", ""));
    document.querySelector(".count").id = "countNum";
  }

  function onSearchInput() {
    state.query = searchInput.value;
    state.page = 0;
    state.focusId = null;
    writeUrl(true);
    renderFeed();
  }

  function init() {
    fetch("data.json")
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (d) {
        data = d;
        if (!data.page_size) data.page_size = FALLBACK_PAGE;
        data.channels.forEach(function (ch) {
          channelById[ch.key] = ch;
          state.filters[ch.key] = true;
        });
        data.posts.forEach(function (p) {
          p._search = stripTags(p.html).toLowerCase();
        });
        renderFilters();
        searchInput.value = (parseQuery().q != null) ? parseQuery().q : "";
        if (searchInput) searchInput.addEventListener("input", onSearchInput);
        window.addEventListener("popstate", syncFromUrl);
        syncFromUrl();
      })
      .catch(function () {
        statusEl.classList.remove("hidden");
        statusEl.textContent =
          "Не удалось загрузить data.json. Соберите сайт командой «python build.py» " +
          "и откройте в браузере через локальный HTTP-сервер.";
        feed.textContent = "";
      });
  }

  init();
})();
