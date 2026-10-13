# Local build dependency patch

This is a BSD-3-Clause fork of `sprintf-js` 1.1.3, copied from its published source. The upstream copyright and license are retained in LICENSE. It is used only through the explicit npm override, not a claimed upstream release.

GHSA-hp3w-g68c-fv3c / CVE-2026-97058 describes uncaught RangeError from unbounded numeric precision. As of 2026-10-13 the advisory lists no fixed upstream version: https://github.com/advisories/GHSA-hp3w-g68c-fv3c . The reachable local chain is electron-builder → @electron/get → global-agent → roarr's logger → sprintf-js. The viewer does not import this build dependency.

Changes: clamp e/f precision to 0–100 and g to 1–100 before numeric formatting; clamp width to 4096 to bound padding; cap the parser cache at 256 formats. Normal formatting remains compatible. No electron-builder downgrade is required. Tests exercise all precision families, huge decimal specifiers, width, named/positional formatting and the installed roarr chain. Remove this local override only after a maintained upstream replacement passes those checks and npm audit.
