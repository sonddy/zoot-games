# Telegram Mini App Setup

Zoot Games runs inside Telegram as a Mini App: players open the bot, tap
"Play", and get the full site (all 24 games, sports betting, predictions, TV)
inside Telegram. Login is automatic via their Telegram account; on phones they
can also connect Phantom and place real SOL / $ZOOT bets without leaving the
flow (via the wallet bridge — see "How the wallet works" below).

## 1. Create the bot (one time, ~2 minutes)

1. In Telegram, open [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, pick a display name (e.g. `Zoot Games`) and a username
   (e.g. `ZootGamesBot` — must end in `bot`).
3. BotFather replies with the **bot token** (looks like
   `1234567890:AAF...xyz`). Keep it secret.

## 2. Configure the server

Set two environment variables (on Render: dashboard → zoot-games →
Environment):

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from BotFather |
| `PUBLIC_URL` | `https://zootgames.org` (already set in render.yaml) |

Redeploy. On boot the server automatically:

- registers the webhook (`/telegram/webhook`) with Telegram,
- sets the bot's menu button to open the game,
- starts answering `/start` with a "Play Zoot Games" button.

Look for `[telegram] bot @YourBot ready` in the logs.

## 3. Optional polish (in BotFather)

- `/setuserpic` — bot avatar.
- `/setdescription` — text shown before users press Start.
- `/newapp` — creates a named Mini App so you get a shareable
  `https://t.me/YourBot/play` link (point it at `https://zootgames.org`).

## How login works

When the site runs inside Telegram, the client sends Telegram's signed
`initData` with its socket registration. The server verifies the HMAC
signature using the bot token, so Telegram identities can't be forged.
Players get a `tg:<id>` identity and land straight in the lobby.

## How the wallet works in Telegram

Telegram's webview has no browser extensions, so on phones the app uses
Phantom's encrypted universal-link protocol (same one the Android app uses):

1. The Mini App opens a `phantom.app/ul/...` link — the Phantom app opens.
2. After the user approves, Phantom redirects to
   `zootgames.org/wallet-return.html`, which relays the (end-to-end
   encrypted) response to the server.
3. The Mini App polls `/api/wallet-bridge/poll` and completes the
   connection or transaction. The server only ferries opaque ciphertext.

On Telegram Desktop there is no Phantom app to hand off to, so players are
asked to open zootgames.org in a normal browser to bet. Watching, browsing
the lobby, and test-mode play work everywhere.

Server-side, identities without a wallet are blocked from every real-money
entry point (`find_match`, house games, bet accepts, sports, predictions).
