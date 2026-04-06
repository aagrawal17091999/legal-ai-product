import os
from dotenv import load_dotenv

# Load .env.local from project root
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))

DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://legaladmin:PASSWORD@localhost:5432/legaldb')

R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '')
R2_ENDPOINT = os.getenv('R2_ENDPOINT', '')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'legal-judgments')

VOYAGE_API_KEY = os.getenv('VOYAGE_API_KEY', '')

# Data directories
DATA_DIR = os.path.join(os.path.dirname(__file__), '..', 'data')
SC_DATA_DIR = os.path.join(DATA_DIR, 'supreme-court')
HC_DATA_DIR = os.path.join(DATA_DIR, 'high-courts')

# Chunk settings
CHUNK_SIZE = 2000  # characters (~500 tokens)
CHUNK_OVERLAP = 200  # characters
VOYAGE_BATCH_SIZE = 128
