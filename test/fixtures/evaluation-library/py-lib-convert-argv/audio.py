import os
import subprocess

FORMATS = {"mp3", "wav", "ogg"}


def convert(source, output_format):
    """Converts an audio file with ffmpeg and returns the new file's path."""
    if output_format not in FORMATS:
        raise ValueError(f"unsupported format: {output_format}")
    source = os.path.abspath(source)
    output = os.path.abspath(f"{source}.{output_format}")
    subprocess.run(["ffmpeg", "-y", "-i", source, output], check=True)
    return output
