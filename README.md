# Frixion for computers

A desktop app for Frixion. It opens your Frixion website in its own window (with the title bar your site already has), sits in the
system tray, can start with the computer, and **detects games and Spotify automatically** so Activity Status works like Discord's.

The app only shows your site, so website changes show up instantly. People only reinstall the app when this folder changes.

## 1. Point it at your site
Edit `config.json` and put your real site address in `url` (the same one people open in a browser, with the https://):

```json
{ "url": "https://yourname.github.io/yourrepo/" }
```

## 2. Try it on your own computer (needs Node.js 18 or newer from nodejs.org)
```
npm install
npm test        # checks the game detector
npm start       # opens the app
```

## 3. Make installers for everyone
Easiest: let GitHub build them.
1. Create a new GitHub repository (for example `frixion-desktop`) and upload everything in this folder to it (keep the `.github` folder).
2. On GitHub: **Releases → Draft a new release → Choose a tag**, type `v1.0.0`, and publish. (The **Actions** tab → **Run workflow** only does a test build; it does not publish.)
3. After a few minutes the Windows `.exe`, Mac `.dmg` and Linux `.AppImage` appear on that release. Share the link.

Or build on your own computer: `npm run dist` (installers appear in `dist/`; each system builds its own kind).

## Updates (automatic)
Installed apps update themselves. To ship a new version, publish a new release with a higher tag (`v1.0.1`, `v1.0.2`, ...). The build
copies the tag into the app's version for you. Windows and Linux copies check GitHub 15 seconds after opening and every 4 hours,
download the new version quietly, and restart into it (immediately if the app is only in the tray, or when the person chooses
"Restart now"; otherwise when they next close it).
- The repository must be **public** (a private one needs a login token inside the app).
- **Mac** can't auto-update unsigned apps, so Mac users download the new `.dmg` themselves until you sign the app.
- Remember: changes to the website itself never need a release. Only changes to this folder do.

## What people will see the first time
The installers aren't signed with a paid certificate, so:
- **Windows:** "Windows protected your PC" → click **More info → Run anyway**.
- **Mac:** right-click the app → **Open** (once).
Buying a code-signing certificate (Windows) / Apple Developer account (Mac) removes these warnings.

## What gets detected
- **Games:** the list in `games.json` (about 55 popular games). A game counts while its program is running. To add one, copy a line, change the
  `name` and the program's file name (Windows: find it in Task Manager → Details). Rebuild to ship it.
- **Spotify (the desktop app):** the song and artist. Windows reads the Spotify window title; Mac asks Spotify; Linux needs `playerctl`.
  Spotify in a web browser isn't detected.
- Only program names (and the Spotify window title) are read. Nothing is saved or uploaded; the one thing shared is the activity itself,
  shown to friends, and only while "Share my activity" is on in Frixion's Settings.

## Online status
While the app is running, even only in the tray, friends on the website and in the app see you as **Online**. You show as **Idle**
after 10 minutes without touching the keyboard or mouse, or while the computer is locked. (Needs app version 2.1 or newer.)

## Overlay over games
The overlay shortcut (Settings → Keyboard on the website, Shift + ` by default) opens Frixion's overlay on top of any program,
for example Minecraft or Roblox. A shortcut without Ctrl or Alt (like the default, which types ~) is only taken over while a
game from `games.json` is running, so it keeps typing normally everywhere else. Games in true fullscreen may minimize when the
overlay opens; windowed or borderless fullscreen works best. (Needs app version 2.2 or newer.)

## Files
- `main.js`: the window, tray icon, start-with-computer, game scanning
- `preload.js`: the small, safe bridge the website uses (`window.frixionDesktop`)
- `detector.js` + `games.json`: finds games and the Spotify song
- `offline.html`: shown when there's no internet
- `config.json`: the site address the app opens
- `test/detector.test.js`: `npm test`
- `build/`: app and tray icons
- `.github/workflows/build.yml`: builds the installers on GitHub
