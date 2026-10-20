import json


def restore_state(payload):
    """Rebuilds the state a peer process sent."""
    return json.loads(payload)
