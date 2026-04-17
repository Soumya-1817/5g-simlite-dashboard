# models.py — v5
from dataclasses import dataclass, field
from typing import List

@dataclass
class Packet:
    id:       int
    ue_id:    int
    ue_name:  str
    color:    str
    born:     float
    deadline: float
    size:     int

@dataclass
class SimConfig:
    algo:       str   = "FIFO"
    rate:       float = 2.0
    num_ues:    int   = 3
    speed:      float = 1.0
    noise_rate: float = 0.0    # channel error probability (0.0 – 0.5)
    max_time:   float = 0.0    # simulated seconds to run (0 = unlimited)
