#!/usr/bin/env python3
"""Package the plugin as a KiCad PCM zip: Plugin and Content Manager > Install from File."""
import hashlib
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "jumper")


def build(out_dir):
    with open(os.path.join(SRC, "metadata.json"), encoding="utf-8") as f:
        meta = json.load(f)
    version = meta["versions"][0]["version"]
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "jumper-kicad-%s.zip" % version)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for folder, _dirs, files in os.walk(SRC):
            for name in sorted(files):
                if name.endswith((".pyc", ".pyo")) or "__pycache__" in folder:
                    continue
                full = os.path.join(folder, name)
                z.write(full, os.path.relpath(full, SRC))
    digest = hashlib.sha256(open(out, "rb").read()).hexdigest()
    print("%s  sha256=%s  size=%d" % (out, digest, os.path.getsize(out)))
    return out


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "dist"))
