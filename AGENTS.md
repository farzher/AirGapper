# AirGapper

Build a simple, fully offline screen-to-camera file and text transfer tool, primarily for an older Android receiver with no network connection.

- The web app is plain browser-native JavaScript/ESM. Source files are the runnable files; source files run directly in the browser; there is no transpile or bundle step.
- The APK packages the same browser-native source directly. Keep syntax conservative and avoid introducing bundler-only APIs.
- Do not add build tooling for ordinary web development. Edit the .js source and push it directly. Keep the root/module layout flat and delete dead helpers instead of creating wrappers.
- Do not add or run tests or verification. Do not add prose documentation.
- Do not preserve compatibility with older AirGapper versions; remove obsolete code instead of adding migrations or fallbacks.
- Optimize for fast iteration and minimal direct changes.
- After changes: bump version, commit, push.
- Keep UI clean and minimal with few words and a nice User Experience.
