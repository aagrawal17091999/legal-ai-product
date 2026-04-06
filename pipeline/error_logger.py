"""
Centralized error logger for the Python pipeline.
Writes to the same error_logs PostgreSQL table used by the TypeScript backend.
"""
import json
import traceback
import psycopg2
from config import DATABASE_URL


def log_error(category, message, severity="error", error=None, metadata=None):
    """
    Fire-and-forget error logging to the error_logs table.
    Never raises — falls back to print on failure.
    """
    try:
        stack_trace = None
        if error is not None:
            stack_trace = "".join(
                traceback.format_exception(type(error), error, error.__traceback__)
            )

        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO error_logs (category, severity, message, stack_trace, metadata)
               VALUES (%s, %s, %s, %s, %s)""",
            [
                category,
                severity,
                message[:5000],
                stack_trace,
                json.dumps(metadata or {}),
            ],
        )
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"[error-logger] Failed to persist error: {e}")
        print(f"[error-logger] Original: {message}")
