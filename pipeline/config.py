import io
import os
from dotenv import load_dotenv, dotenv_values

PROJECT_ROOT = os.path.join(os.path.dirname(__file__), '..')


def _load_env_file_first_wins(path: str) -> None:
    """Load ENV_FILE so a repeated key resolves to its FIRST assignment.

    That is how every scripts/*.sh read_var() resolves keys (grep | head -1),
    and .env.production.local on the box repeats keys (DATABASE_URL twice; the
    first is the live one). python-dotenv and systemd's EnvironmentFile both
    take the LAST one, so the pipeline would silently disagree with the rest of
    the box. Variables already set in the process environment still win.
    """
    seen = set()
    with open(path) as f:
        for line in f:
            key = line.split('=', 1)[0].strip()
            if '=' not in line or key.startswith('#') or key in seen:
                continue
            seen.add(key)
            value = dotenv_values(stream=io.StringIO(line)).get(key)
            if value is not None:
                os.environ.setdefault(key, value)


# ENV_FILE selects the environment, like scripts/*.sh (the box uses
# .env.production.local). Without it, fall back to .env.local for local runs.
_env_file = os.getenv('ENV_FILE')
if _env_file:
    if not os.path.isabs(_env_file):
        _env_file = os.path.join(PROJECT_ROOT, _env_file)
    _load_env_file_first_wins(_env_file)
else:
    load_dotenv(os.path.join(PROJECT_ROOT, '.env.local'))

DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://legaladmin:PASSWORD@localhost:5432/legaldb')

R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '')
R2_ENDPOINT = os.getenv('R2_ENDPOINT', '')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'legal-judgments')

VOYAGE_API_KEY = os.getenv('VOYAGE_API_KEY', '')

# Data directories
DATA_DIR = os.getenv('PIPELINE_DATA_DIR') or os.path.join(PROJECT_ROOT, 'data')
SC_DATA_DIR = os.path.join(DATA_DIR, 'supreme-court')
HC_DATA_DIR = os.path.join(DATA_DIR, 'high-courts')

# Chunk settings
CHUNK_SIZE = 2000  # characters (~500 tokens)
CHUNK_OVERLAP = 200  # characters
VOYAGE_BATCH_SIZE = 64
