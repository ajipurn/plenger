import pickle


def restore_state(payload):
    """Rebuilds the state a peer process sent."""
    return pickle.loads(payload)
