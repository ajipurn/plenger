from dataclasses import dataclass


@dataclass
class Settings:
    ping: str = "/bin/ping"


def get_settings() -> Settings:
    return Settings()
