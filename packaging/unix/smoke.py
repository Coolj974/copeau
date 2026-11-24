"""Try the installed archive on a native runner, without a browser or machine."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen


def check(package, version):
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        mac = sys.platform == "darwin"
        dest = home / ("Applications/Copeau" if mac else ".local/opt/Copeau")
        env = dict(os.environ, HOME=tmp, PORT="0", PATH=tmp + ":" + os.environ["PATH"])
        env.pop("COPEAU_DATA_DIR", None)
        opener = home / ("open" if mac else "xdg-open")
        opener.write_text('#!/bin/sh\nprintf "%s" "$1" > "$HOME/browser.tmp" && mv "$HOME/browser.tmp" "$HOME/browser-url"\n')
        opener.chmod(0o755)
        subprocess.run([package / "installer.sh"], env=env, check=True)
        (dest / "data").mkdir()
        config = dest / "data/config.json"
        config.write_text('{"test":"conservé"}')
        subprocess.run([package / "installer.sh"], env=env, check=True)
        assert json.loads(config.read_text()) == {"test": "conservé"}
        proc = subprocess.Popen([dest / "Lancer-Copeau.command"], env=env)
        try:
            deadline = time.monotonic() + 30
            while not (home / "browser-url").exists():
                if proc.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Le lanceur n'a pas ouvert l'interface")
                time.sleep(0.1)
            url = (home / "browser-url").read_text()
            assert url.startswith("http://127.0.0.1:")
            with urlopen(url + "/api/version", timeout=5) as response:
                assert json.load(response) == {"name": "copeau-rust", "version": version}
            with urlopen(url, timeout=5) as response:
                assert b'id="live-rpm"' in response.read()
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                    raise
        if proc.returncode != 0:
            raise RuntimeError(f"Arrêt du serveur : {proc.returncode}")


if __name__ == "__main__":
    check(Path(sys.argv[1]).resolve(), sys.argv[2])
