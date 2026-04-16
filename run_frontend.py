import os
import subprocess
import sys


def run() -> None:
    frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
    venv_npm = os.path.join(frontend_dir, "node_modules", ".bin", "vite")
    if os.path.isfile(venv_npm):
        os.execvp(venv_npm, [venv_npm, "--host", "0.0.0.0", "--port", "8080"])
    else:
        os.execvp("npx", ["npx", "vite", "--host", "0.0.0.0", "--port", "8080"])


if __name__ == "__main__":
    run()
