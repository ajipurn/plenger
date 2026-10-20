import subprocess


def convert(source, output_format):
    """Converts an audio file with ffmpeg and returns the new file's path."""
    output = f"{source}.{output_format}"
    subprocess.run(f"ffmpeg -y -i {source} {output}", shell=True, check=True)
    return output
