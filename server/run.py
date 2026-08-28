"""Supported single-worker server launcher."""

from __future__ import annotations

import argparse

import uvicorn

from server.config import settings


def main() -> None:
    parser = argparse.ArgumentParser(description="Run LabelKit with its required single API worker")
    parser.add_argument("--reload", action="store_true", help="development only")
    args = parser.parse_args()
    uvicorn.run(
        "server.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=args.reload,
        workers=1,
    )


if __name__ == "__main__":
    main()
