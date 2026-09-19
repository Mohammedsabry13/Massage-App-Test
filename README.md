# Massage Session Timer (PWA)

Personal-use app: automatic timing per movement, 2-minute prep countdown, 3 alert sounds + vibration,
pause/resume, temporary records (auto-deleted), Arabic/English.

New in this version: manual session length (hours + minutes), custom extras, a fully editable plan
(reorder / rename / add / delete cards and movements, colors, images), clock times (Alexandria) next to each card,
expandable and editable records with start/end time, and a 4th sound for the end of the 2-minute preparation.

## Put it on your phone (Android + Chrome)
The app must be served over HTTPS to be installable. Easiest free options:

1. **Netlify Drop**: open https://app.netlify.com/drop, drag this whole folder onto the page. You get an https link.
2. **GitHub Pages** or **Vercel**: upload the folder as a static site (no build step, no dependencies).

Then on the phone: open the link in Chrome, menu (⋮) -> "Install app" / "Add to Home screen".
After the first open it works offline.

## Test on your computer
    cd massage-app
    python3 -m http.server 8000     # then open http://localhost:8000

## Files
- `plan.js`   : all timing logic (order left->right, time shares, redistribution). Edit `PARTS` to change movements/weights.
- `i18n.js`   : every text in Arabic and English (movement names included).
- `app.js`    : screens, sounds, vibration, storage.
- `styles.css`, `index.html`, `manifest.webmanifest`, `sw.js`, `icons/`

## After you change any file
Change `CACHE = 'mp-v3'` in `sw.js` to `mp-v4` (and so on) so phones pick up the update.
