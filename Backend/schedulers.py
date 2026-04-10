# schedulers.py — pure scheduling algorithm implementations
# Each function receives the current queue (list of Packet) and returns
# the Packet that should be transmitted next, or None if the queue is empty.

from typing import List, Optional
from models import Packet


def fifo(queue: List[Packet]) -> Optional[Packet]:
    """
    First In First Out — serve the packet that arrived earliest.
    Fairness: none. Latency: unpredictable for late arrivals.
    """
    return queue[0] if queue else None


def round_robin(queue: List[Packet], rr_ptr: int) -> Optional[Packet]:
    """
    Round Robin — cycle through active UEs, picking each one's
    first queued packet in turn. Guarantees fairness across UEs.
    """
    if not queue:
        return None
    # Collect unique UE ids present in the queue, sorted for determinism
    ue_ids = sorted({p.ue_id for p in queue})
    target_ue = ue_ids[rr_ptr % len(ue_ids)]
    # Find first packet belonging to the target UE
    return next((p for p in queue if p.ue_id == target_ue), queue[0])


def edf(queue: List[Packet]) -> Optional[Packet]:
    """
    Earliest Deadline First — always serve the packet whose deadline
    expires soonest. Optimal for real-time traffic; can starve others.
    """
    return min(queue, key=lambda p: p.deadline) if queue else None
