# main.py — FastAPI WebSocket server v4 (with noise support)
# Run: python -m uvicorn main:app --reload --port 8000

import asyncio, json, logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from models import SimConfig
from simulation import SimEngine

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("5g-simlite")

app = FastAPI(title="5G-SimLite Backend", version="4.0")
app.add_middleware(CORSMiddleware,allow_origins=["*"],allow_methods=["*"],allow_headers=["*"])

@app.get("/")
async def root(): return {"status":"ok","service":"5G-SimLite Backend v4"}

@app.websocket("/ws/sim")
async def simulation_ws(ws: WebSocket):
    await ws.accept(); log.info("Client connected")
    engine=None; stream_task=None

    async def _send_info(msg):
        try: await ws.send_text(json.dumps({"type":"info","msg":msg,"simT":0}))
        except: pass

    async def _stop():
        nonlocal engine,stream_task
        if engine: engine.stop()
        if stream_task and not stream_task.done():
            stream_task.cancel()
            try: await stream_task
            except asyncio.CancelledError: pass
        engine=None; stream_task=None

    try:
        while True:
            cmd=json.loads(await ws.receive_text()); kind=cmd.get("type","")
            if kind=="start":
                await _stop()
                cfg=SimConfig(
                    algo       = cmd.get("algo","FIFO"),
                    rate       = float(cmd.get("rate",2.0)),
                    num_ues    = int(cmd.get("numUes",3)),
                    speed      = float(cmd.get("speed",1.0)),
                    noise_rate = float(cmd.get("noiseRate",0.0)),  # ← noise from frontend
                )
                engine=SimEngine(cfg)
                stream_task=asyncio.create_task(engine.stream(ws))
                await _send_info(f"▶ SimPy started [{cfg.algo}] {cfg.num_ues} UEs rate={cfg.rate} speed={cfg.speed}x noise={cfg.noise_rate*100:.0f}%")
                log.info("Sim started: %s",cfg)
            elif kind=="pause"  and engine: engine.pause();  await _send_info("⏸ Paused")
            elif kind=="resume" and engine: engine.resume(); await _send_info("▶ Resumed")
            elif kind=="reset": await _stop(); await _send_info("↺ Reset")
            elif kind=="config" and engine:
                if "algo" in cmd: engine.cfg.algo=cmd["algo"]; await _send_info(f"⚙ Algo → {cmd['algo']}")
            elif kind=="speed"  and engine: engine.cfg.speed=float(cmd.get("speed",1)); await _send_info(f"⚡ Speed → {engine.cfg.speed}x")
            elif kind=="noise"  and engine: engine.cfg.noise_rate=float(cmd.get("noiseRate",0)); await _send_info(f"📡 Noise → {engine.cfg.noise_rate*100:.0f}%")
    except WebSocketDisconnect: log.info("Client disconnected")
    except Exception as e: log.exception("Error: %s",e)
    finally: await _stop()
