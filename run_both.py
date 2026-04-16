#!/usr/bin/env python3
import os
import subprocess
import sys


def main() -> None:
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_dir = os.path.join(backend_dir, "frontend")
    venv_python = os.path.join(backend_dir, ".venv", "bin", "python")

    if not os.path.isfile(venv_python):
        print("ERROR: .venv not found. Run: python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'", file=sys.stderr)
        sys.exit(1)

    npm_bin = os.path.join(frontend_dir, "node_modules", ".bin", "npm")
    if not os.path.isfile(npm_bin):
        npm_bin = "npm"

    backend_proc = subprocess.Popen(
        [venv_python, "run_backend.py"],
        cwd=backend_dir,
    )

    frontend_proc = subprocess.Popen(
        [npm_bin, "run", "dev"],
        cwd=frontend_dir,
    )

    print("Both servers started. Press Ctrl+C to stop.")
    print("- Backend:  http://localhost:8000")
    print("- Frontend: http://localhost:8080")
    print("- API docs: http://localhost:8000/docs")

    try:
        backend_proc.wait()
        frontend_proc.wait()
    except KeyboardInterrupt:
        print("\nShutting down servers...")
        backend_proc.terminate()
        frontend_proc.terminate()
        backend_proc.wait(timeout=5)
        frontend_proc.wait(timeout=5)
        print("Servers stopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
