# schedulers.py — v5: FIFO, Round Robin, EDF, Proportional Fair, Priority-Based
from typing import List, Optional, Dict
from models import Packet


def fifo(queue: List[Packet]) -> Optional[Packet]:
    """First In First Out — serve earliest-arrived packet."""
    return queue[0] if queue else None


def round_robin(queue: List[Packet], rr_ptr: int) -> Optional[Packet]:
    """Round Robin — cycle through active UEs in sorted order."""
    if not queue:
        return None
    ue_ids = sorted({p.ue_id for p in queue})
    target = ue_ids[rr_ptr % len(ue_ids)]
    return next((p for p in queue if p.ue_id == target), queue[0])


def edf(queue: List[Packet]) -> Optional[Packet]:
    """Earliest Deadline First — serve packet with nearest deadline."""
    return min(queue, key=lambda p: p.deadline) if queue else None


def proportional_fair(
    queue: List[Packet],
    avg_tp: Dict[int, float],
) -> Optional[Packet]:
    """
    Proportional Fair — mirrors real 5G NR scheduler.

    Score per UE = instantaneous_rate / average_throughput
    • instantaneous_rate proxy: 1000 / packet_size
      (smaller packets = higher effective modulation/coding)
    • avg_tp: per-UE EWMA of delivered rate, updated after each RX.

    The UE with the highest score is selected (head-of-line packet).
    This balances system throughput against individual fairness:
    a UE that has received little service lately gets a high score
    even if its instantaneous rate is modest.
    """
    if not queue:
        return None
    # Head-of-line candidate per UE
    candidates: Dict[int, Packet] = {}
    for p in queue:
        if p.ue_id not in candidates:
            candidates[p.ue_id] = p

    best, best_score = None, float("-inf")
    for ue_id, p in candidates.items():
        inst_rate = 1000.0 / max(p.size, 1)
        avg = avg_tp.get(ue_id, 0.01)
        score = inst_rate / avg
        if score > best_score:
            best_score = score
            best = p
    return best or queue[0]


# QoS tier weights mirroring 5G NR QCI classes (index → weight)
_QOS_WEIGHTS = [4, 3, 2, 1, 1, 1]  # UE-0 has highest priority


def priority_based(queue: List[Packet], num_ues: int) -> Optional[Packet]:
    """
    Priority-Based (QoS Classes) — mirrors 5G NR QCI/5QI framework.

    UEs are assigned QoS tiers by index:
      UE-0 → QCI-1 GBR (weight 4, highest)
      UE-1 → QCI-4 GBR (weight 3)
      UE-2 → QCI-6 NGBR (weight 2)
      UE-3+ → QCI-9 NGBR (weight 1, best-effort)

    Higher-weight UEs are always scheduled first.
    Within the same tier, FIFO ordering applies.
    """
    if not queue:
        return None
    def weight(p: Packet) -> int:
        return _QOS_WEIGHTS[p.ue_id] if p.ue_id < len(_QOS_WEIGHTS) else 1

    # Sort by weight DESC then by arrival time ASC (FIFO within tier)
    return sorted(queue, key=lambda p: (-weight(p), p.born))[0]
