#!/usr/bin/env python3
"""Run both frontend and backend servers concurrently."""

import multiprocessing
import sys


def run_backend() -> None:
    from citysim.server import run

    run()


def run_frontend() -> None:
    import os
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    os.chdir("frontend")
    server = ThreadingHTTPServer(("0.0.0.0", 8080), SimpleHTTPRequestHandler)
    print("Frontend server running at http://localhost:8080")
    server.serve_forever()


if __name__ == "__main__":
    multiprocessing.set_start_method("spawn", force=True)

    backend_process = multiprocessing.Process(target=run_backend, name="backend")
    frontend_process = multiprocessing.Process(target=run_frontend, name="frontend")

    backend_process.start()
    frontend_process.start()

    print("Both servers started. Press Ctrl+C to stop.")
    print("- Backend: http://localhost:8000")
    print("- Frontend: http://localhost:8080")

    try:
        backend_process.join()
        frontend_process.join()
    except KeyboardInterrupt:
        print("\nShutting down servers...")
        backend_process.terminate()
        frontend_process.terminate()
        backend_process.join()
        frontend_process.join()
        print("Servers stopped.")
        sys.exit(0)
