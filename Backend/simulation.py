# simulation.py — v5: PF + Priority schedulers, max_time support
import simpy, random, asyncio, json
from typing import List, Tuple, Dict, Any, Optional
from models import Packet, SimConfig
from schedulers import fifo, round_robin, edf, proportional_fair, priority_based

QUEUE_CAP = 8
UE_COLORS = ["#00f5ff","#ff00aa","#39ff14","#ff6b00","#a855f7","#ffcc00"]

# EWMA alpha for PF throughput tracking
PF_ALPHA = 0.1


class SimEngine:
    def __init__(self, config: SimConfig):
        self.cfg          = config
        self.env          = simpy.Environment()
        self.buffer: List[Packet] = []
        self._pkt_ready   = self.env.event()
        self.pkt_n  = 0
        self.sent   = 0
        self.drops  = 0
        self.retx   = 0
        self.delays: List[float] = []
        self.rr_ptr = 0
        # PF: per-UE EWMA of instantaneous rate
        self.avg_tp: Dict[int, float] = {}
        self._buf: List[Tuple[float, Dict[str, Any]]] = []
        self._pause_ev = asyncio.Event()
        self._pause_ev.set()
        self._stopped = False

    # ── Internal helpers ──────────────────────────────────────
    def _emit(self, msg: Dict[str, Any]):
        self._buf.append((self.env.now, msg))

    def _pick(self) -> Optional[Packet]:
        al = self.cfg.algo
        if al == "FIFO":  return fifo(self.buffer)
        elif al == "RR":  p = round_robin(self.buffer, self.rr_ptr); self.rr_ptr += 1; return p
        elif al == "EDF": return edf(self.buffer)
        elif al == "PF":  return proportional_fair(self.buffer, self.avg_tp)
        elif al == "PRIO": return priority_based(self.buffer, self.cfg.num_ues)
        return fifo(self.buffer)

    def _queue_snapshot(self) -> List[Dict]:
        return [{"id":p.id,"ueId":p.ue_id,"name":p.ue_name,"color":p.color,
                 "sz":p.size,"dl":round(p.deadline,2),"born":round(p.born,2)}
                for p in self.buffer]

    # ── SimPy processes ───────────────────────────────────────
    def _ue_process(self, ue_id: int):
        ue_name = f"UE-{ue_id+1}"
        color   = UE_COLORS[ue_id % len(UE_COLORS)]
        while not self._stopped:
            # Stop at max_time
            if self.cfg.max_time > 0 and self.env.now >= self.cfg.max_time:
                return
            lam = self.cfg.rate / self.cfg.num_ues
            yield self.env.timeout(random.expovariate(lam))
            if self.cfg.max_time > 0 and self.env.now > self.cfg.max_time:
                return
            self.pkt_n += 1
            pkt = Packet(
                id=self.pkt_n, ue_id=ue_id, ue_name=ue_name, color=color,
                born=self.env.now,
                deadline=self.env.now + 1.5 + random.uniform(0, 3.5),
                size=random.randint(100, 550),
            )
            self._emit({"type":"gen","pktId":pkt.id,"ueId":ue_id,"ueName":ue_name,
                        "color":color,"sz":pkt.size})
            yield self.env.timeout(0.04)
            if len(self.buffer) >= QUEUE_CAP:
                self.drops += 1
                self._emit({"type":"drop","pktId":pkt.id,"drops":self.drops,
                            "msg":f"PKT #{pkt.id} DROPPED — queue full!"})
            else:
                self.buffer.append(pkt)
                self._emit({"type":"queued","pktId":pkt.id,"q":self._queue_snapshot(),
                            "msg":f"PKT #{pkt.id} queued [{len(self.buffer)}/{QUEUE_CAP}]"})
                if not self._pkt_ready.triggered:
                    self._pkt_ready.succeed()
                    self._pkt_ready = self.env.event()

    def _scheduler_loop(self):
        while not self._stopped:
            # Stop at max_time
            if self.cfg.max_time > 0 and self.env.now >= self.cfg.max_time:
                self._stopped = True
                return
            if not self.buffer:
                yield self._pkt_ready
            if not self.buffer:
                continue
            sel = self._pick()
            if sel is None:
                continue
            self.buffer.remove(sel)
            delay  = self.env.now - sel.born
            tx_sec = 0.35 + (sel.size / 1000) * 1.5
            self._emit({
                "type":"sched","pktId":sel.id,"ueName":sel.ue_name,"color":sel.color,
                "algo":self.cfg.algo,"delay":round(delay,3),"txSec":round(tx_sec,2),
                "q":self._queue_snapshot(),
                "pkt":{"id":sel.id,"ueId":sel.ue_id,"name":sel.ue_name,
                       "color":sel.color,"sz":sel.size},
                "msg":f"[{self.cfg.algo}] selected PKT #{sel.id} "
                      f"({sel.ue_name}, delay={delay:.2f}s)",
            })
            yield self.env.timeout(tx_sec)

            # ── Channel noise check ────────────────────────────
            if random.random() < self.cfg.noise_rate:
                self.retx += 1
                self.buffer.insert(0, sel)
                self._emit({"type":"retx","pktId":sel.id,"retx":self.retx,
                            "msg":f"PKT #{sel.id} LOST in channel! Retransmit #{self.retx} "
                                  f"(noise={self.cfg.noise_rate*100:.0f}%)"})
                if not self._pkt_ready.triggered:
                    self._pkt_ready.succeed()
                    self._pkt_ready = self.env.event()
            else:
                # Successful delivery
                self.sent += 1
                self.delays.append(delay)

                # ── PF: update EWMA throughput for this UE ─────
                inst_rate = 1000.0 / max(sel.size, 1)
                self.avg_tp[sel.ue_id] = (
                    (1 - PF_ALPHA) * self.avg_tp.get(sel.ue_id, inst_rate)
                    + PF_ALPHA * inst_rate
                )

                avg_d = sum(self.delays) / len(self.delays)
                tp    = self.sent / max(self.env.now, 0.01)
                self._emit({
                    "type":"rx","pktId":sel.id,"delay":round(delay,3),
                    "metrics":{
                        "tp":round(tp,2),"delay":round(avg_d,3),
                        "drops":self.drops,"tx":self.sent,"retx":self.retx,
                    },
                    "msg":f"PKT #{sel.id} received ✓  delay={delay:.2f}s",
                })

    # ── Main async streaming loop ─────────────────────────────
    async def stream(self, websocket):
        for i in range(self.cfg.num_ues):
            self.env.process(self._ue_process(i))
        self.env.process(self._scheduler_loop())
        last_sim_t = 0.0

        while not self._stopped:
            await self._pause_ev.wait()
            try:
                next_t = self.env.peek()
            except Exception:
                break
            if next_t == float("inf"):
                await asyncio.sleep(0.1)
                continue

            # ── Max-time guard ─────────────────────────────────
            if self.cfg.max_time > 0 and next_t > self.cfg.max_time:
                # Flush final events then emit "done"
                for (sim_t, msg) in self._buf:
                    msg["simT"] = round(sim_t, 2)
                    try:
                        await websocket.send_text(json.dumps(msg))
                    except Exception:
                        return
                self._buf.clear()
                try:
                    await websocket.send_text(json.dumps({
                        "type":"done","simT":round(self.cfg.max_time, 2),
                        "msg":f"✓ Simulation completed — {self.cfg.max_time}s limit reached",
                    }))
                except Exception:
                    pass
                self._stopped = True
                return

            sim_dt  = next_t - last_sim_t
            real_dt = sim_dt / max(self.cfg.speed, 0.1)
            if real_dt > 0:
                await asyncio.sleep(real_dt)
            self.env.step()
            last_sim_t = self.env.now

            for (sim_t, msg) in self._buf:
                msg["simT"] = round(sim_t, 2)
                try:
                    await websocket.send_text(json.dumps(msg))
                except Exception:
                    self._stopped = True
                    return
            self._buf.clear()

    def pause(self):  self._pause_ev.clear()
    def resume(self): self._pause_ev.set()
    def stop(self):   self._stopped = True; self._pause_ev.set()
