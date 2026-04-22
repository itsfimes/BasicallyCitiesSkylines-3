"""Frontend launcher used by local Python-first development workflow.

Ensures frontend dependencies exist, then starts Vite on the standard project
port so it can proxy backend APIs during development.
"""

import os
import shutil
import subprocess
import sys


def ensure_frontend_dependencies(frontend_dir: str) -> None:
    """Ensure Vite dependencies are installed before frontend startup.

    Used by: run() and run_both.py workflows to make local startup robust when
    node_modules is missing.
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


def run() -> None:
    """Start Vite dev server on project-standard host/port.

    Used by: direct `python run_frontend.py` execution and multi-process dev
    orchestration where frontend should proxy backend APIs.
    """
    frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
    ensure_frontend_dependencies(frontend_dir)
    vite_bin = os.path.join(frontend_dir, "node_modules", ".bin", "vite")
    if os.path.isfile(vite_bin):
        os.chdir(frontend_dir)
        os.execvp(vite_bin, [vite_bin, "--host", "0.0.0.0", "--port", "8080"])

    npm_bin = shutil.which("npm")
    if npm_bin is None:
        print(
            "ERROR: frontend/node_modules/.bin/vite is missing and npm is not available in PATH.",
            file=sys.stderr,
        )
        sys.exit(1)

    os.execvp(
        npm_bin,
        [npm_bin, "run", "dev", "--", "--host", "0.0.0.0", "--port", "8080"],
    )


if __name__ == "__main__":
    run()
