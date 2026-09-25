"""plenger: local-first security analysis for repositories and LLM applications."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("plenger")
except PackageNotFoundError:  # Running from a source tree without installation.
    __version__ = "0+unknown"
