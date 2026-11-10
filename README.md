# Letters to Abba

A private, offline prayer journal. Write dated letters (prayers) to Abba, track how He answers, and keep a Book of Remembrance.

- Works offline once opened (installable app / "Add to Home Screen")
- Every letter is encrypted on the device (AES-256-GCM, key unlocked by your passphrase or recovery key)
- No server, no accounts, no tracking. Letters never leave the device
- Encrypted backup and restore (`.abba` file)

## Publishing (GitHub Pages)
1. Upload all these files to the root of a repository called `letters-to-abba`.
2. Settings → Pages → Build and deployment → Source: **Deploy from a branch** → Branch: **main**, folder **/ (root)** → Save.
3. After 1–2 minutes the site is live at `https://<account>.github.io/letters-to-abba/`.

## Updating
When you change any file, also change `VERSION` at the top of `sw.js` (e.g. `abba-v1.0.1`) so phones pick up the new version.

## Helplines
Add verified helpline numbers in `app.js` → `HELPLINES` near the top.

Made by GIDI.
