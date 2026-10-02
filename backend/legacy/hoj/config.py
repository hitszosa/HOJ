from __future__ import annotations

from pathlib import Path
import os

import yaml
try:
    from yaml import CSafeLoader as SafeLoader, CSafeDumper as SafeDumper  # noqa: F401
except ImportError:
    from yaml import SafeLoader, SafeDumper  # noqa: F401


def yaml_load(stream):
    return yaml.load(stream, Loader=SafeLoader)


# backend/ 根目录：.env、data/ 与 schema/ 都相对于它定位。
ROOT = Path(__file__).resolve().parents[2]


def load_local_env():
    env_path = ROOT / '.env'
    if env_path.is_file():
        try:
            for line in env_path.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    k, v = k.strip(), v.strip().strip("'\"")
                    if k and k not in os.environ:
                        os.environ[k] = v
        except Exception:
            pass


load_local_env()
