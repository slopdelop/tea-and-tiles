# UI verification

Before committing or publishing UI/layout changes, run the relevant isolated browser regressions and inspect their screenshots. Include touch-enabled iPad landscape and portrait sizes, particularly 1024×768, a shorter Safari viewport (1024×660), 1180×820, 1366×1024, and 768×1024 or 820×1180. Check that Games and New game remain adjacent, the rack and its controls do not overlap, and Help stays accessible.

Use `UI_TEST_GREP` with `npm run test:ui` for focused checks. These tests use their own emulator project and ports; never reset production or the ordinary development game for UI verification. Distinguish browser emulation from testing on a physical iPad when reporting results.
