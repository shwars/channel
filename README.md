# channel

Статический сайт (GitHub Pages) с архивом постов двух Telegram-каналов:
**Облачный адвокат** и **Курированная жизнь**. Посты объединяются в одну
ленту (по дате убывания) с возможностью отфильтровать каналы, постраничной
навигацией и раскрывающимися комментариями.

## Обновление сайта

1. Замените экспорт в папке `source/`:
   - `source/cloud-advocate/` — экспорт чата «Чат облачного адвоката»
     (канал `channel1488671565`);
   - `source/curated-life/` — экспорт «Говорим про жизнь» (канал
     `channel2884425554`);
   - кладите рядом media-папки (`photos`, `video_files`, `files`,
     `round_video_messages`, `stickers`), как в исходном экспорте.
2. Закоммитьте и запушите: `git add source && git commit && git push`.
3. GitHub Actions соберёт сайт и опубликует на
   `https://shwars.github.io/channel`.

Префетч ссылок (og-заголовки мини-превью) кэшируется в
`source/previews_cache.json` и обновляется только для новых ссылок.

## Локальная сборка

```bash
pip install requests beautifulsoup4
python build.py --out _site          # соберёт _site (с сетевым префетчем)
# без сети (только кэш и fallback-карточки ссылок):
python build.py --out _site --no-fetch
cd _site && python -m http.server 8000
# открыть http://127.0.0.1:8000/
```

Устройство:
- `build.py` — обработка экспортов, сбор `_site/data.json`, копирование медиа,
  префетч ссылок;
- `web/` — статический интерфейс (`index.html`, `style.css`, `app.js`);
- `.github/workflows/build-pages.yml` — сборка и публикация в ветку `gh-pages`.
