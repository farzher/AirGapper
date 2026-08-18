import subprocess

SOURCE_COMMIT = 'f66261c2765444019cc6b7c5383bb242ae5611ef'
raw = subprocess.check_output(
    ['git', 'show', f'{SOURCE_COMMIT}:.github/v240_adaptive_nors_patch.py'],
    text=True,
)
raw = raw.replace(
    '            return direct.isValid() ? direct : DecoderResult{};',
    '            if (direct.isValid()) return std::move(direct);\n            return {};',
)
raw = raw.replace(
    '    return direct.isValid() ? direct : decoded;',
    '    if (direct.isValid()) return std::move(direct);\n    return decoded;',
)
if 'return direct.isValid() ? direct' in raw:
    raise SystemExit('move-only DecoderResult ternary remains')
exec(compile(raw, '<v240-adaptive-nors>', 'exec'), {'__name__': '__main__'})
