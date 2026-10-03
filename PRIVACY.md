# Hearthwork Privacy (draft)

> Draft written for the fork. Review it against the code before you publish builds, and have it
> checked by someone qualified if you distribute Hearthwork to other people. This is not legal advice.

Hearthwork is a **local-first desktop app**. It runs a small local server (the "sidecar") on your
machine and does the agent work there.

- **No telemetry.** No analytics, crash reporting or ad SDKs ship in the app.
- **Your data stays on your machine**, in your OS app-data folder under `app.hearthwork.desktop`
  (Windows `%APPDATA%`, macOS `~/Library/Application Support`, Linux `~/.local/share`).
- **Model providers.** When an agent runs, your prompts and tool results go to the AI provider you
  configured, with your own API key, under that provider's terms.
- **API keys** are stored in the operating system keychain (service `app.hearthwork.desktop`), never
  in the frontend.
- **Optional self-hosted services.** If the deployment you use sets service URLs in `brand.json`
  (phone relay, skill catalog, update server), the app contacts those servers only for that feature.
  Out of the box all of them are off.

Contact: yash.dighe@gmail.com
