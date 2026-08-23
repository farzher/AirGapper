from pathlib import Path

p = Path('send/main.js')
s = p.read_text()
s = s.replace('const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";', 'const SEND_SETTINGS_KEY = "airgapper:send-settings:v2";', 1)
s = s.replace('''  cfgSize.add(new Option("Auto", "auto", false, true));
  Array.from(FRAME_BYTES_OPTIONS.entries()).reverse().forEach(([level, bytes]) => cfgSize.add(new Option(formatBytes(bytes), String(level))));
  restoreSendSettings();
''', '''  cfgSize.add(new Option("Auto", "auto"));
  Array.from(FRAME_BYTES_OPTIONS.entries()).reverse().forEach(([level, bytes]) => cfgSize.add(new Option(formatBytes(bytes), String(level))));
  cfgSize.value = "auto";
  restoreSendSettings();
''', 1)
p.write_text(s)

Path('version.js').write_text('export const APP_VERSION = "0.5.388";\nexport const APP_BUILD = `v${APP_VERSION}`;\n')
