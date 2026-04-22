"""Thin CLI entrypoint that boots the FastAPI simulation server."""

from citysim.server import run


if __name__ == "__main__":
    """Launch backend API server from repository root entrypoint.

    Used by: local development scripts and run_both.py process orchestration.
    """
    run()
