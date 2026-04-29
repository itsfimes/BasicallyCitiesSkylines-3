#!/usr/bin/env python3
"""Developer orchestration entrypoint for backend + frontend processes.

This script ensures frontend dependencies and then runs both servers together
to provide the full local simulation stack (API + dashboard) in one command.
"""

import os
import shutil
import subprocess
import sys
import time


def ensure_frontend_dependencies(frontend_dir: str) -> None:
    """Install frontend dependencies if Vite binary is absent.

    Used by: main() before launching both backend and frontend subprocesses.
    """
    vite_bin = os.path.join(frontend_dir, "node_modules", ".bin", "vite")
    package_lock_path = os.path.join(frontend_dir, "package-lock.json")
    package_json_path = os.path.join(frontend_dir, "package.json")

    if os.path.isfile(vite_bin):
        return

    if not os.path.isfile(package_json_path):
        print("ERROR: frontend/package.json not found.", file=sys.stderr)
        sys.exit(1)

    npm_bin = shutil.which("npm")
    if npm_bin is None:
        print(
            "ERROR: frontend dependencies are missing and npm is not available in PATH. "
            "Install Node.js/npm, then run 'cd frontend && npm install'.",
            file=sys.stderr,
        )
        sys.exit(1)

    install_cmd = [npm_bin, "ci"] if os.path.isfile(package_lock_path) else [npm_bin, "install"]

    print("Installing frontend dependencies...", file=sys.stderr)
    subprocess.run(install_cmd, cwd=frontend_dir, check=True)


def main() -> None:
    """Run backend and frontend together and manage coordinated shutdown.

    Used by: local full-stack development where one command should bring up the
    complete simulation stack.
    """
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_dir = os.path.join(backend_dir, "frontend")
    venv_python = os.path.join(backend_dir, ".venv", "bin", "python")

    if not os.path.isfile(venv_python):
        print(
            "ERROR: .venv not found. Run: python3 -m venv .venv && "
            ".venv/bin/pip install -e '.[dev]'",
            file=sys.stderr,
        )
        sys.exit(1)

    ensure_frontend_dependencies(frontend_dir)

    npm_bin = shutil.which("npm")
    if npm_bin is None:
        print("ERROR: npm is not available in PATH.", file=sys.stderr)
        sys.exit(1)

    backend_proc = subprocess.Popen(
        [venv_python, "run_backend.py"],
        cwd=backend_dir,
    )

    frontend_proc = subprocess.Popen(
        [npm_bin, "run", "dev", "--", "--host"],
        cwd=frontend_dir,
    )

    print("Both servers started. Press Ctrl+C to stop.")
    print("- Backend:  http://localhost:8000")
    print("- Frontend: http://localhost:8080")
    print("- API docs: http://localhost:8000/docs")

    try:
        backend_return = backend_proc.poll()
        frontend_return = frontend_proc.poll()

        while backend_return is None and frontend_return is None:
            time.sleep(0.5)
            backend_return = backend_proc.poll()
            frontend_return = frontend_proc.poll()

        if frontend_return is not None and backend_return is None:
            print("Frontend exited unexpectedly. Stopping backend...", file=sys.stderr)
            backend_proc.terminate()
            backend_proc.wait(timeout=5)
            sys.exit(frontend_return)

        if backend_return is not None and frontend_return is None:
            print("Backend exited unexpectedly. Stopping frontend...", file=sys.stderr)
            frontend_proc.terminate()
            frontend_proc.wait(timeout=5)
            sys.exit(backend_return)

        if backend_return is None:
            backend_return = 0
        if frontend_return is None:
            frontend_return = 0

        sys.exit(backend_return or frontend_return)
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
