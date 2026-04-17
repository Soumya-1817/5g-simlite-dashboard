# main.py — FastAPI WebSocket server v5
# New in v5: Proportional Fair + Priority schedulers, max_time support
#
# Run: python -m uvicorn main:app --reload --port 8000
#
# ── Client → Server messages ─────────────────────────────────────────────────
#   {"type":"start",  "algo":"PF", "rate":2, "numUes":3, "speed":1,
#                     "noiseRate":0.05, "maxTime":30}
#   {"type":"pause"}
#   {"type":"resume"}
#   {"type":"reset"}
#   {"type":"config", "algo":"PRIO"}     ← change scheduler mid-run
#   {"type":"speed",  "speed":2}
#   {"type":"noise",  "noiseRate":0.1}
#
# ── Server → Client messages ─────────────────────────────────────────────────
#   {"type":"gen"|"drop"|"queued"|"sched"|"rx"|"retx"|"info"|"done", "simT":f}

import asyncio
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from models import SimConfig
from simulation import SimEngine

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("5g-simlite")

app = FastAPI(title="5G-SimLite Backend", version="5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

VALID_ALGOS = {"FIFO", "RR", "EDF", "PF", "PRIO"}


@app.get("/")
async def root():
    return {"status": "ok", "service": "5G-SimLite Backend v5",
            "schedulers": list(VALID_ALGOS)}


@app.websocket("/ws/sim")
async def simulation_ws(ws: WebSocket):
    await ws.accept()
    log.info("Client connected")

    engine: SimEngine | None = None
    stream_task: asyncio.Task | None = None

    async def _send_info(msg: str, sim_t: float = 0.0):
        try:
            await ws.send_text(json.dumps({"type": "info", "msg": msg, "simT": sim_t}))
        except Exception:
            pass

    async def _stop_engine():
        nonlocal engine, stream_task
        if engine:
            engine.stop()
        if stream_task and not stream_task.done():
            stream_task.cancel()
            try:
                await stream_task
            except asyncio.CancelledError:
                pass
        engine = None
        stream_task = None

    try:
        while True:
            raw  = await ws.receive_text()
            cmd  = json.loads(raw)
            kind = cmd.get("type", "")

            # ── START ─────────────────────────────────────────────────────
            if kind == "start":
                await _stop_engine()
                algo = cmd.get("algo", "FIFO").upper()
                if algo not in VALID_ALGOS:
                    algo = "FIFO"
                cfg = SimConfig(
                    algo       = algo,
                    rate       = float(cmd.get("rate",      2.0)),
                    num_ues    = int(cmd.get("numUes",    3)),
                    speed      = float(cmd.get("speed",     1.0)),
                    noise_rate = float(cmd.get("noiseRate", 0.0)),
                    max_time   = float(cmd.get("maxTime",   0.0)),
                )
                engine      = SimEngine(cfg)
                stream_task = asyncio.create_task(engine.stream(ws))
                time_info = f"  limit={cfg.max_time}s" if cfg.max_time > 0 else "  unlimited"
                await _send_info(
                    f"▶ SimPy started [{cfg.algo}]  {cfg.num_ues} UEs  "
                    f"rate={cfg.rate} pkt/s  speed={cfg.speed}×  "
                    f"noise={cfg.noise_rate*100:.0f}%{time_info}"
                )
                log.info("Simulation started: %s", cfg)

            # ── PAUSE / RESUME / RESET ────────────────────────────────────
            elif kind == "pause" and engine:
                engine.pause()
                await _send_info("⏸ Paused")

            elif kind == "resume" and engine:
                engine.resume()
                await _send_info("▶ Resumed")

            elif kind == "reset":
                await _stop_engine()
                await _send_info("↺ Reset")
                log.info("Simulation reset")

            # ── LIVE CONFIG CHANGES ───────────────────────────────────────
            elif kind == "config" and engine:
                if "algo" in cmd:
                    algo = cmd["algo"].upper()
                    if algo in VALID_ALGOS:
                        engine.cfg.algo = algo
                        await _send_info(f"⚙ Scheduler → {algo}")

            elif kind == "speed" and engine:
                engine.cfg.speed = float(cmd.get("speed", 1.0))
                await _send_info(f"⚡ Speed → {engine.cfg.speed}×")

            elif kind == "noise" and engine:
                engine.cfg.noise_rate = float(cmd.get("noiseRate", 0.0))
                await _send_info(f"📡 Noise → {engine.cfg.noise_rate*100:.0f}%")

    except WebSocketDisconnect:
        log.info("Client disconnected")
    except Exception as exc:
        log.exception("Unexpected error: %s", exc)
    finally:
        await _stop_engine()
