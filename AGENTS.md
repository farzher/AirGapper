# AGENTS.md

## Goal
Build AirGapper: a simple, fully offline screen-to-camera file/data transfer tool.

Primary target:
- Send files/data from a computer to an older Android phone with no network connection.
- Push the highest practical transfer bandwidth while remaining reliable on slower phone hardware.

## Priorities
- Offline-first.
- High KB/s.
- Reliable under dropped/blurred frames.
- Keep the UI minimal.
- Optimize the hot path aggressively.
- After changes, commit and push.