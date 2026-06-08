# Readable Water Budget

A Chrome extension that overlays a clean, honest dashboard on the Waterscope
(Metron) water-meter portal: how much water you've used this cycle, how much is
left, your pace vs. your daily target, and whether you're actually on track.

Everything runs locally in your browser using your own logged-in session. No
data is collected or sent anywhere. Works on desktop Chrome.

## Try it locally (before the Web Store listing)
1. Go to chrome://extensions
2. Turn on "Developer mode" (top right)
3. Click "Load unpacked" and select this folder
4. Open waterscope.us, log in. The dashboard opens automatically.

## Files
- manifest.json   - extension config (MV3)
- content.js      - the dashboard (reads + parses + renders)
- fonts/          - bundled Inter (so it renders right under any page CSP)
- icons/          - extension icons
