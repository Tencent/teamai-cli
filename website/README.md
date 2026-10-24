# TeamAI website

Standalone static site for [#1131](https://github.com/Tencent/teamai-cli/issues/1131). Node.js 20+; no dependencies, CLI code, or copied documentation.

```sh
cd website
npm run build
npm test
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

Open `http://127.0.0.1:4173`. Python 3 is only needed for this local preview command; any static file server works. Deploy the contents of `website/dist/` to a static host. Links and assets are relative, so the site also works below a URL path. Hosting, domain, and automatic publication are left for the maintainers to choose.

## Contribute a real use case

First share a proposal in [#1131](https://github.com/Tencent/teamai-cli/issues/1131): how your team set TeamAI up and how it uses it. Include the tools you use, a public-safe repo layout, and one real workflow. Do not include private code, credentials, or invented results.

After agreeing the scope, contribute an HTML page under `website/use-cases/` and link it from the homepage's use-cases section. Use relative asset links (for example `../styles.css`) and accessible headings. The build copies these pages unchanged. If a case is written in another language, set its HTML `lang` appropriately.

There are no contributed cases yet. Keep `use-cases/` empty until the first real contribution; Git does not track empty directories, so the build creates it if missing. Do not add a placeholder story or `.gitkeep` there.
