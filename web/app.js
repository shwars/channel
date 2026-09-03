(function () {
  "use strict";
  var FALLBACK_PAGE = 20;
  var data = null;
  var channelById = {};
  var state = { page: 0, filters: {} };

  var feed = document.getElementById("feed");
  var pager = document.getElementById("pager");
  var filtersEl = document.getElementById("filters");
  var statusEl = document.getElementById("status");

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
    var box = el("div", "media");
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

  function renderComments(post, card) {
    var toggle = el("button", "comments-toggle");
    toggle.appendChild(el("span", "cicon", "▶"));
    toggle.appendChild(el("span", "clabel", "Комментарии" +
      (post.comments_n ? " · " + post.comments_n : "")));

    var listWrap = null;
    toggle.addEventListener("click", function () {
      var open = card.classList.toggle("open");
      if (open && !listWrap) {
        listWrap = el("div", "comments-list");
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
            var wrap = el("div");
            wrap.appendChild(m);
            cc.appendChild(wrap);
          }
          listWrap.appendChild(cc);
        });
        card.appendChild(listWrap);
      }
    });
    return toggle;
  }

  function buildCard(post) {
    var card = el("article", "card");
    card.id = "post-" + post.key;

    var head = el("div", "card-head");
    var ch = channelById[post.channel];
    head.appendChild(el("span", "ch-tag " + post.channel, ch ? ch.label : post.channel));
    head.appendChild(el("span", "card-date", fmtDate(post.ts)));
    if (post.edited_ts) head.appendChild(el("span", "edited", "(изм.)"));
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

    card.appendChild(renderComments(post, card));
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
    for (i = start; i <= end; i++) out.push(i);
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
      if (!disabled) b.addEventListener("click", function () { go(page); });
      pager.appendChild(b);
    };
    nav("←", state.page - 1, state.page === 0);
    pageWindow(totalPages).forEach(function (item) {
      if (item === "…") { pager.appendChild(el("span", "ell", "…")); return; }
      var b = el("button", "", String(item));
      if (item === state.page + 1) b.classList.add("active");
      b.addEventListener("click", function () { go(item - 1); });
      pager.appendChild(b);
    });
    nav("→", state.page + 1, state.page >= totalPages - 1);
  }

  function go(page) {
    state.page = page;
    writeHash();
    renderFeed();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderFeed() {
    var posts = data.posts.filter(function (p) { return state.filters[p.channel]; });
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

  function parseHash() {
    var params = {};
    location.hash.replace(/^#/, "").split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return params;
  }
  function writeHash() {
    var c = data.channels.filter(function (ch) { return state.filters[ch.key]; })
      .map(function (ch) { return ch.key; }).join(",");
    location.hash = c ? ("p=" + state.page + "&c=" + c) : ("p=" + state.page);
  }
  function applyHash() {
    var params = parseHash();
    var c = params.c;
    data.channels.forEach(function (ch) {
      state.filters[ch.key] = (c == null) ? true : (c.indexOf(ch.key) >= 0);
    });
    var p = parseInt(params.p, 10);
    if (!isNaN(p) && p >= 0) state.page = p;
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
        writeHash();
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
        renderFilters();
        applyHash();
        renderFeed();
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
