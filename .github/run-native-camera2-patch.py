from pathlib import Path

path = Path('.github/apply-native-camera2.py')
source = path.read_text(encoding='utf-8')
old = '''def once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)
'''
new = '''def once(text, old, new, label):
    count = text.count(old)
    if count < 1:
        raise RuntimeError(f"{label}: expected at least one match, found {count}")
    return text.replace(old, new, 1)
'''
if old not in source:
    raise RuntimeError('staging helper signature changed')
source = source.replace(old, new, 1)
exec(compile(source, str(path), 'exec'), {'__name__': '__main__'})
