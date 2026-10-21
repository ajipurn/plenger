import tarfile


def unpack_upload(archive_path, dest_dir):
    with tarfile.open(archive_path) as tar:
        tar.extractall(dest_dir)


def unpack_checked(archive_path, dest_dir):
    with tarfile.open(archive_path) as tar:
        tar.extractall(dest_dir, filter="data")


def unpack_bundled(dest_dir):
    with tarfile.open("assets/templates.tar.gz") as tar:
        tar.extractall(dest_dir)


def check_archive(archive_path):
    with tarfile.open(archive_path) as tar:
        for member in tar.getmembers():
            if member.name.startswith(("/", "..")) or member.issym():
                raise ValueError(member.name)


def unpack_after_check(archive_path, dest_dir):
    check_archive(archive_path)
    with tarfile.open(archive_path) as tar:
        tar.extractall(dest_dir)
