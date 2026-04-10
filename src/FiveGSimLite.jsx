/**
 * FiveGSimLite.jsx — v4
 *
 * ① UE add/remove works in Python mode BEFORE simulation starts
 * ② Responsive layout — desktop / tablet / mobile
 * ③ Channel noise — user-controlled error rate + randomize button
 *    → failed packets are retransmitted automatically
 * ④ Comparison mode — run any two schedulers side-by-side (separate page)
 * ⑤ Enhanced CSV export — includes noise config + retransmission data
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { AreaChart, Area, BarChart, Bar, ResponsiveContainer, Tooltip, Cell } from "recharts";

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════
const QUEUE_CAP = 8;
const TICK_MS   = 50;
const BASE_DT   = 0.05;
const MAX_UES   = 6;
const WS_URL    = "wss://fiveg-simlite-backend.onrender.com/ws/sim";

// Main SVG canvas (home page)
const SVG_W = 680, SVG_H = 340;
const BS  = { x: 340, y: 170 };
const RX  = { x: 608, y: 170 };

// Mini SVG canvas (comparison page)
const MINI_W = 480, MINI_H = 240;
const MINI_BS = { x: 240, y: 120 };
const MINI_RX = { x: 430, y: 120 };

const UE_COLOR_POOL = ["#00f5ff","#ff00aa","#39ff14","#ff6b00","#a855f7","#ffcc00"];

const EV_C = {
  gen:"#39ff14", queue:"#00f5ff", queued:"#00f5ff",
  sched:"#ff00aa", tx:"#ffcc00", rx:"#39ff14",
  drop:"#ff4444", retx:"#ff8800", info:"#3a6a7a",
};

const SCHED_DESC = {
  FIFO:"First In First Out — packets served in exact arrival order.",
  RR:  "Round Robin — each UE served in rotation for fairness.",
  EDF: "Earliest Deadline First — soonest deadline always served first.",
};

const SPEED_OPTS = [0.5, 1, 1.5, 2];
const DEFAULT_UES = () => [
  {id:0,color:UE_COLOR_POOL[0],name:"UE-1"},
  {id:1,color:UE_COLOR_POOL[1],name:"UE-2"},
  {id:2,color:UE_COLOR_POOL[2],name:"UE-3"},
];

// ═══════════════════════════════════════════════════════════
// PURE HELPERS
// ═══════════════════════════════════════════════════════════
const getUEPositions = (n, mini = false) => {
  if (!n) return [];
  const cx = mini ? 55 : 75;
  if (n === 1) return [{ x:cx, y: mini?120:170 }];
  const top = mini?30:50, bot = mini?210:290;
  const step = (bot-top)/(n-1);
  return Array.from({length:n},(_,i)=>({x:cx,y:Math.round(top+i*step)}));
};

const buildPath = (fx,fy,tx,ty) => `M${fx},${fy} L${tx},${ty}`;

const schedFIFO = (q) => q[0];
const schedRR   = (q,ptr) => {
  const ids=[...new Set(q.map(p=>p.ueId))].sort((a,b)=>a-b);
  return q.find(p=>p.ueId===ids[ptr%ids.length])??q[0];
};
const schedEDF  = (q) => [...q].sort((a,b)=>a.dl-b.dl)[0];

// ═══════════════════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════════════════
function exportCSV({algo,rate,speed,noise,numUes,history,events,metrics,label=""}) {
  const ts  = new Date().toISOString().replace(/[:.]/g,"-");
  const lbl = label ? `_${label}` : "";
  const lines = [];

  lines.push("# 5G-SimLite Simulation Export");
  lines.push(`# Generated,${new Date().toLocaleString()}`);
  lines.push(`# Scheduler,${algo}`);
  lines.push(`# Arrival Rate,${rate} pkt/s`);
  lines.push(`# Speed,${speed}x`);
  lines.push(`# UE Count,${numUes}`);
  lines.push(`# Channel Noise Rate,${(noise*100).toFixed(1)}%`);
  lines.push(`# Final Throughput,${metrics.tp} pkt/s`);
  lines.push(`# Final Avg Delay,${metrics.delay} s`);
  lines.push(`# Total Drops,${metrics.drops}`);
  lines.push(`# Total TX Success,${metrics.tx}`);
  lines.push(`# Total Retransmissions,${metrics.retx??0}`);
  lines.push("");
  lines.push("METRICS HISTORY");
  lines.push("Sim Time (s),Throughput (pkt/s),Avg Delay (s)");
  history.forEach(h=>lines.push(`${h.t},${h.tp},${h.d}`));
  lines.push("");
  lines.push("EVENT LOG");
  lines.push("Sim Time (s),Event Type,Message");
  [...events].reverse().forEach(ev=>
    lines.push(`${ev.t},${ev.type},"${ev.msg.replace(/"/g,'""')}"`)
  );

  const blob = new Blob([lines.join("\n")],{type:"text/csv;charset=utf-8;"});
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"),{href:url,download:`5g-simlite-${algo}${lbl}-${ts}.csv`});
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════
// useJSSim — REUSABLE JS SIMULATION HOOK
// Used once on home page, twice on comparison page.
// ═══════════════════════════════════════════════════════════
function useJSSim(initAlgo="FIFO", mini=false) {
  const [status,    setStatus]    = useState("idle");
  const [algo,      setAlgo]      = useState(initAlgo);
  const [rate,      setRate]      = useState(2);
  const [speed,     setSpeed]     = useState(1);
  const [noise,     setNoise]     = useState(0);        // 0.0 – 0.5
  const [ues,       setUes]       = useState(DEFAULT_UES);
  const [queue,     setQueue]     = useState([]);
  const [events,    setEvents]    = useState([]);
  const [metrics,   setMetrics]   = useState({tp:0,delay:0,drops:0,tx:0,retx:0});
  const [txPkt,     setTxPkt]     = useState(null);
  const [anims,     setAnims]     = useState([]);
  const [history,   setHistory]   = useState([]);
  const [activeUes, setActiveUes] = useState(new Set());
  const [rxFlash,   setRxFlash]   = useState(false);
  const [simT,      setSimT]      = useState(0);

  const sim    = useRef({t:0,q:[],rrPtr:0,nxtMap:{0:0,1:0,2:0},txing:false,sent:0,drop:0,retx:0,dlys:[],n:0,gen:0});
  const idCtr  = useRef(3);
  const iRef   = useRef(null);
  const evRef  = useRef([]);
  const anRef  = useRef([]);
  const alRef  = useRef(algo);
  const rtRef  = useRef(rate);
  const spRef  = useRef(speed);
  const noiseRef = useRef(noise);
  const uesRef = useRef(ues);
  const tkRef  = useRef(null);

  alRef.current   = algo;
  rtRef.current   = rate;
  spRef.current   = speed;
  noiseRef.current = noise;
  uesRef.current  = ues;

  const logEv = useCallback((t,msg,type)=>{
    const ev={id:`${t}-${Math.random()}`,t:typeof t==="number"?t.toFixed(2):String(t),msg,type};
    evRef.current=[ev,...evRef.current].slice(0,150);
    setEvents([...evRef.current]);
  },[]);

  const addAnim = useCallback((fx,fy,tx,ty,col,lbl,ms)=>{
    const id=`${Date.now()}-${Math.random()}`;
    anRef.current=[...anRef.current,{id,fx,fy,tx,ty,col,lbl,ms}];
    setAnims([...anRef.current]);
    setTimeout(()=>{anRef.current=anRef.current.filter(x=>x.id!==id);setAnims([...anRef.current]);},ms+350);
  },[]);

  // Positions depend on mini mode
  const bsNode = mini ? MINI_BS : BS;
  const rxNode = mini ? MINI_RX : RX;

  const doTick = () => {
    const s=sim.current,gen=s.gen,curUes=uesRef.current,sp=spRef.current,r=rtRef.current,nr=noiseRef.current;
    s.t+=BASE_DT*sp;
    const uePosArr=getUEPositions(curUes.length,mini);

    // ── Packet generation ──────────────────────────────────
    curUes.forEach((ue,idx)=>{
      if(!(ue.id in s.nxtMap))s.nxtMap[ue.id]=s.t;
      if(s.t>=s.nxtMap[ue.id]){
        s.nxtMap[ue.id]=s.t+(-Math.log(Math.random()+1e-9)/(r/curUes.length));
        const p={id:++s.n,ueId:ue.id,color:ue.color,name:ue.name,born:s.t,dl:s.t+1.5+Math.random()*3.5,sz:100+~~(Math.random()*450)};
        const uep=uePosArr[idx]||{x:55,y:120};
        const animMs=620/sp;
        addAnim(uep.x,uep.y,bsNode.x,bsNode.y,ue.color,`P${p.id}`,animMs);
        setActiveUes(prev=>new Set([...prev,ue.id]));
        setTimeout(()=>setActiveUes(prev=>{const n=new Set(prev);n.delete(ue.id);return n;}),450);
        logEv(s.t,`PKT #${p.id} generated at ${ue.name} (${p.sz}B)`,"gen");
        setTimeout(()=>{
          if(sim.current.gen!==gen)return;
          if(!uesRef.current.find(u=>u.id===ue.id))return;
          if(s.q.length>=QUEUE_CAP){s.drop++;setMetrics(m=>({...m,drops:s.drop}));logEv(s.t,`PKT #${p.id} DROPPED — queue full!`,"drop");}
          else{s.q.push(p);setQueue([...s.q]);logEv(s.t,`PKT #${p.id} queued [${s.q.length}/${QUEUE_CAP}]`,"queue");}
        },animMs+30);
      }
    });

    // ── Scheduler & TX ─────────────────────────────────────
    if(!s.txing&&s.q.length>0){
      const al=alRef.current;
      let sel=al==="FIFO"?schedFIFO(s.q):al==="RR"?schedRR(s.q,s.rrPtr):schedEDF(s.q);
      if(al==="RR")s.rrPtr++;
      if(!sel)sel=s.q[0];
      s.q=s.q.filter(p=>p.id!==sel.id);
      s.txing=true;
      setQueue([...s.q]);
      setTxPkt({...sel});
      const delay=s.t-sel.born;
      const txSec=0.35+(sel.sz/1000)*1.5;
      const txMs=(txSec*1000)/sp;
      logEv(s.t,`[${al}] selected PKT #${sel.id} (${sel.name}, delay=${delay.toFixed(2)}s)`,"sched");
      addAnim(bsNode.x,bsNode.y,rxNode.x,rxNode.y,sel.color,`P${sel.id}`,txMs*0.82);

      setTimeout(()=>{
        if(sim.current.gen!==gen)return;
        // ── Channel noise check ──────────────────────────
        if(Math.random()<nr){
          // Packet lost in channel → retransmit
          s.retx++;
          s.txing=false;
          s.q.unshift({...sel});   // put back at front of queue
          setQueue([...s.q]);
          setTxPkt(null);
          setMetrics(m=>({...m,retx:s.retx}));
          logEv(s.t,`PKT #${sel.id} ✗ LOST in channel! Retransmit #${s.retx} (noise=${(nr*100).toFixed(0)}%)`,"retx");
        } else {
          // Successful delivery
          s.txing=false;
          s.sent++;
          s.dlys.push(delay);
          setTxPkt(null);
          setRxFlash(true);
          setTimeout(()=>setRxFlash(false),700);
          const avgD=s.dlys.reduce((a,b)=>a+b,0)/s.dlys.length;
          const tp=s.sent/Math.max(s.t,0.01);
          setMetrics({tp:+tp.toFixed(2),delay:+avgD.toFixed(3),drops:s.drop,tx:s.sent,retx:s.retx});
          setHistory(h=>[...h.slice(-60),{t:~~s.t,tp:+tp.toFixed(2),d:+avgD.toFixed(3)}]);
          logEv(s.t,`PKT #${sel.id} received ✓  delay=${delay.toFixed(2)}s`,"rx");
        }
      },txMs);
    }
    setSimT(+(s.t).toFixed(2));
  };
  tkRef.current=doTick;

  const start = () => {
    setStatus("running");
    iRef.current=setInterval(()=>tkRef.current(),TICK_MS);
    logEv(0,"▶ Simulation started","info");
  };
  const pause = () => {
    clearInterval(iRef.current);
    setStatus("paused");
    logEv(sim.current.t,"⏸ Paused","info");
  };
  const resume = () => {
    setStatus("running");
    iRef.current=setInterval(()=>tkRef.current(),TICK_MS);
    logEv(sim.current.t,"▶ Resumed","info");
  };
  const reset = () => {
    clearInterval(iRef.current);
    const nm={};uesRef.current.forEach(u=>{nm[u.id]=0;});
    sim.current={t:0,q:[],rrPtr:0,nxtMap:nm,txing:false,sent:0,drop:0,retx:0,dlys:[],n:0,gen:sim.current.gen+1};
    evRef.current=[];anRef.current=[];
    setStatus("idle");setQueue([]);setEvents([]);setAnims([]);setTxPkt(null);
    setHistory([]);setSimT(0);setActiveUes(new Set());setRxFlash(false);
    setMetrics({tp:0,delay:0,drops:0,tx:0,retx:0});
    logEv(0,"↺ Reset","info");
  };

  // UE management (available in both modes, at any time)
  const addUE = () => {
    if(ues.length>=MAX_UES)return;
    const newId=idCtr.current++;
    const nu={id:newId,color:UE_COLOR_POOL[newId%UE_COLOR_POOL.length],name:`UE-${newId+1}`};
    const nues=[...ues,nu];setUes(nues);uesRef.current=nues;
    sim.current.nxtMap[newId]=sim.current.t;
    logEv(sim.current.t,`+ Added ${nu.name}`,"gen");
  };
  const removeUE = (id) => {
    if(ues.length<=1)return;
    const nues=ues.filter(u=>u.id!==id);
    setUes(nues);uesRef.current=nues;
    sim.current.q=sim.current.q.filter(p=>p.ueId!==id);
    setQueue([...sim.current.q]);
    delete sim.current.nxtMap[id];
    setActiveUes(prev=>{const n=new Set(prev);n.delete(id);return n;});
    logEv(sim.current.t,`− Removed ${ues.find(u=>u.id===id)?.name}`,"drop");
  };

  useEffect(()=>()=>clearInterval(iRef.current),[]);

  return {
    status,algo,setAlgo,rate,setRate,speed,setSpeed,noise,setNoise,
    ues,addUE,removeUE,setUes,
    queue,events,metrics,txPkt,anims,history,activeUes,rxFlash,simT,
    start,pause,resume,reset,logEv,
    // External setters — used by Python WebSocket mode to drive the same UI
    setQueueExt:    setQueue,
    setMetricsExt:  setMetrics,
    setTxPktExt:    setTxPkt,
    setHistoryExt:  setHistory,
    setRxFlashExt:  setRxFlash,
    setActiveUesExt:setActiveUes,
    addAnimExt:     addAnim,
  };
}

// ═══════════════════════════════════════════════════════════
// APP ROUTER — switches between Home and Compare pages
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [page, setPage] = useState("home");
  if(page==="compare") return <ComparePage onBack={()=>setPage("home")}/>;
  return <HomePage onCompare={()=>setPage("compare")}/>;
}

// ═══════════════════════════════════════════════════════════
// HOME PAGE
// ═══════════════════════════════════════════════════════════
function HomePage({ onCompare }) {
  const sim = useJSSim("FIFO", false);
  const {
    status,algo,setAlgo,rate,setRate,speed,setSpeed,noise,setNoise,
    ues,addUE,removeUE,
    queue,events,metrics,txPkt,anims,history,activeUes,rxFlash,simT,
    start,pause,resume,reset,
  } = sim;

  // Python mode state
  const [simMode,   setSimMode]   = useState("js");
  const [wsState,   setWsState]   = useState("closed");
  const [hovTip,    setHovTip]    = useState(null);
  const wsRef  = useRef(null);
  const evRef2 = useRef([]);

  // Noise UI
  const [noiseInput, setNoiseInput] = useState("0");
  const randomizeNoise = () => {
    const r = +(Math.random()*0.40).toFixed(2);
    setNoise(r);
    setNoiseInput((r*100).toFixed(0));
  };

  // Keep noiseInput in sync with noise slider
  const handleNoiseSlider = (v) => {
    setNoise(v);
    setNoiseInput((v*100).toFixed(0));
  };
  const handleNoiseInput = (v) => {
    const n = Math.min(50, Math.max(0, +v||0));
    setNoiseInput(String(n));
    setNoise(+(n/100).toFixed(3));
  };

  // ── Local refs — mirror ues & speed so handleWsMsg always
  //    sees the latest values without stale closure issues.
  //    (uesRef / spRef only exist inside useJSSim, not here.)
  const pyUesRef   = useRef(ues);
  const pySpeedRef = useRef(speed);
  useEffect(()=>{ pyUesRef.current   = ues;   }, [ues]);
  useEffect(()=>{ pySpeedRef.current = speed; }, [speed]);

  // Python-mode sim time — updated from WS messages
  const [pySimT, setPySimT] = useState(0);

  // WS helpers for Python mode
  const logPy = useCallback((t,msg,type)=>{
    const ev={id:`${t}-${Math.random()}`,t:typeof t==="number"?t.toFixed(2):String(t),msg,type};
    evRef2.current=[ev,...evRef2.current].slice(0,150);
    sim.logEv(t,msg,type);
  },[sim]);

  // Separate status tracker for Python mode
  const [pyStatus, setPyStatus] = useState("idle");

  const handleWsMsg = useCallback((raw)=>{
    let msg; try{ msg=JSON.parse(raw); }catch{ return; }
    const t = msg.simT ?? 0;

    // Update Python sim-time display
    setPySimT(+(+t).toFixed(2));

    switch(msg.type){

      // ── Packet generated at UE → animate dot UE → BS ──────
      case "gen":{
        // Use local pyUesRef — always contains latest UE list
        const curUes   = pyUesRef.current;
        const uePosArr = getUEPositions(curUes.length, false);

        // Python sends ueId as 0-based index; match by position
        const ueIdx = msg.ueId < uePosArr.length ? msg.ueId : 0;
        const uep   = uePosArr[ueIdx] ?? { x:75, y:170 };

        // Animation duration scales with current speed
        const animMs = 620 / Math.max(pySpeedRef.current, 0.1);

        // ① Spawn glowing dot: UE → Base Station (dashed guide line path)
        sim.addAnimExt(uep.x, uep.y, BS.x, BS.y, msg.color, `P${msg.pktId}`, animMs);

        // ② Flash UE node (pulse ring effect)
        sim.setActiveUesExt(prev => new Set([...prev, msg.ueId]));
        setTimeout(()=>
          sim.setActiveUesExt(prev=>{ const n=new Set(prev); n.delete(msg.ueId); return n; }),
        450);

        logPy(t, `PKT #${msg.pktId} generated at ${msg.ueName} (${msg.sz}B)`, "gen");
        break;
      }

      // ── Packet dropped (queue full) ────────────────────────
      case "drop":
        logPy(t, msg.msg, "drop");
        sim.setMetricsExt(m=>({...m, drops:msg.drops}));
        break;

      // ── Packet successfully queued ─────────────────────────
      case "queued":
        sim.setQueueExt(msg.q ?? []);
        logPy(t, msg.msg, "queue");
        break;

      // ── Retransmission (noise check failed) ───────────────
      case "retx":
        logPy(t, msg.msg, "retx");
        sim.setMetricsExt(m=>({...m, retx:msg.retx}));
        break;

      // ── Scheduler selected a packet → TX starts ────────────
      // Animate dot: Base Station → Receiver (bold solid line path)
      case "sched":{
        const txMs = (msg.txSec * 1000) / Math.max(pySpeedRef.current, 0.1);

        // Update queue panel and TX banner
        sim.setQueueExt(msg.q ?? []);
        sim.setTxPktExt(msg.pkt ?? null);

        logPy(t, msg.msg, "sched");
        logPy(t, `PKT #${msg.pktId} TX started → ${msg.txSec}s air time`, "tx");

        // ③ Spawn glowing dot: Base Station → Receiver (bold line path)
        sim.addAnimExt(BS.x, BS.y, RX.x, RX.y, msg.color, `P${msg.pktId}`, txMs * 0.82);
        break;
      }

      // ── Packet received at destination ─────────────────────
      case "rx":
        sim.setTxPktExt(null);
        // ④ Flash receiver node green
        sim.setRxFlashExt(true);
        setTimeout(()=> sim.setRxFlashExt(false), 700);
        logPy(t, msg.msg, "rx");
        if(msg.metrics){
          sim.setMetricsExt(msg.metrics);
          sim.setHistoryExt(h=>[...h.slice(-60), {
            t:  ~~(+t),
            tp: msg.metrics.tp,
            d:  msg.metrics.delay,
          }]);
        }
        break;

      // ── Info / status messages from backend ────────────────
      case "info":
        logPy(t, msg.msg, "info");
        break;

      default: break;
    }
  },[logPy, sim]);

  const connectWS = useCallback(()=>{
    if(wsRef.current?.readyState===WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen  = ()=>{ setWsState("open");   logPy(0,"🔌 Connected to Python backend","info"); };
    ws.onclose = ()=>{ setWsState("closed"); setPyStatus("idle"); logPy(0,"🔌 Disconnected from backend","info"); };
    ws.onerror = ()=>{ setWsState("error");  logPy(0,"⚠ WebSocket error — is the backend running?","drop"); };
    ws.onmessage = (e) => handleWsMsg(e.data);
  },[handleWsMsg, logPy]);

  useEffect(()=>{
    if(simMode==="python") connectWS();
    else{ wsRef.current?.close(); setPyStatus("idle"); }
  },[simMode]); // eslint-disable-line

  useEffect(()=>()=>{ wsRef.current?.close(); },[]);

  const isPython   = simMode==="python";
  // In Python mode use pyStatus so JS sim state doesn't interfere
  const activeStatus = isPython ? pyStatus : status;
  const queueFull  = queue.length>=QUEUE_CAP;
  const uePosArr   = getUEPositions(ues.length,false);
  const statusColor= {idle:"#ff4444",running:"#39ff14",paused:"#ffcc00"}[activeStatus];
  const wsStatusColor = wsState==="open"?"#39ff14":wsState==="error"?"#ff4444":"#3a4a5a";
  const canExport  = history.length>0||events.length>0;

  // ── doStart: single-fire guard prevents duplicate WS messages ──
  const doStart = ()=>{
    // Hard guard — never send if already running or paused
    if(activeStatus !== "idle") return;
    if(isPython){
      if(wsRef.current?.readyState !== WebSocket.OPEN){
        logPy(0,"⚠ Backend not connected — wait for LIVE status","drop");
        return;
      }
      // Mark running immediately so button disappears before WS round-trip
      setPyStatus("running");
      wsRef.current.send(JSON.stringify({
        type:"start", algo, rate, numUes:ues.length, speed, noiseRate:noise,
      }));
      logPy(0,"▶ Sent start command to Python backend","info");
    } else {
      start();
    }
  };

  return (
    <div style={{fontFamily:"'Share Tech Mono',monospace",background:"#030d1a",minHeight:"100vh",color:"#b8ccd8",overflow:"hidden"}}>
      <GlobalStyles/>

      {/* ═══ HEADER ══════════════════════════════════════ */}
      <header className="app-header">
        <div>
          <div className="brand">⬡ 5G-SIMLITE</div>
          <div className="brand-sub">PACKET SCHEDULER SIMULATION v4</div>
        </div>

        <div className="header-controls">
          {/* Mode toggle */}
          <div>
            <div className="ctrl-label">ENGINE</div>
            <div style={{display:"flex",gap:4}}>
              <button className={`mode-btn${simMode==="js"?" mode-js":""}`}
                onClick={()=>{if(activeStatus!=="idle"){reset();setPyStatus("idle");}setSimMode("js");}}>⚡ JS</button>
              <button className={`mode-btn${simMode==="python"?" mode-py":""}`}
                onClick={()=>{if(activeStatus!=="idle"){reset();setPyStatus("idle");}setSimMode("python");}}>🐍 PY</button>
            </div>
          </div>

          {/* WS status */}
          {isPython&&(
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <div className={wsState==="open"?"blink":""} style={{width:7,height:7,borderRadius:"50%",background:wsStatusColor,boxShadow:`0 0 7px ${wsStatusColor}`}}/>
              <span style={{fontSize:8,color:wsStatusColor,letterSpacing:2,whiteSpace:"nowrap"}}>
                {wsState==="open"?"LIVE":wsState==="error"?"ERROR":"OFFLINE"}
              </span>
            </div>
          )}

          {/* Speed */}
          <div className="hide-sm">
            <div className="ctrl-label">SPEED</div>
            <div style={{display:"flex",gap:3}}>
              {SPEED_OPTS.map(s=>(
                <button key={s} className={`spd${speed===s?" on":""}`} style={{width:32}}
                  onClick={()=>{setSpeed(s);if(isPython&&wsRef.current?.readyState===WebSocket.OPEN)wsRef.current.send(JSON.stringify({type:"speed",speed:s}));}}>
                  {s}×
                </button>
              ))}
            </div>
          </div>

          {/* Sim time */}
          <div style={{textAlign:"right"}}>
            <div className="ctrl-label">SIM TIME</div>
            <div style={{fontFamily:"Orbitron",fontSize:14,color:"#ffcc00"}}>
              {(isPython ? pySimT : simT).toFixed(2)}s
            </div>
          </div>

          {/* Status */}
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div className={activeStatus==="running"?"blink":""} style={{width:8,height:8,borderRadius:"50%",background:statusColor,boxShadow:`0 0 9px ${statusColor}`}}/>
            <span style={{fontSize:8,color:statusColor,letterSpacing:3}}>{activeStatus.toUpperCase()}</span>
          </div>

          <div style={{padding:"3px 9px",border:"1px solid rgba(0,245,255,.2)",borderRadius:3,fontSize:9,color:"#00f5ff",fontFamily:"Orbitron"}}>{algo}</div>

          {/* Compare button */}
          <button onClick={onCompare} className="compare-btn" title="Open comparison mode">⚡ COMPARE</button>

          {/* CSV Export */}
          <button
            onClick={()=>exportCSV({algo,rate,speed,noise,numUes:ues.length,history,events,metrics})}
            disabled={!canExport}
            className={`csv-btn${canExport?"":" disabled"}`}
            title="Export results as CSV"
          >⬇ CSV</button>
        </div>
      </header>

      {/* ═══ BODY ═════════════════════════════════════════ */}
      <div className="main-grid">

        {/* ══ LEFT PANEL ══════════════════════════════════ */}
        <div className="left-panel">

          {/* Controls */}
          <div className="panel" style={{padding:12}}>
            <SL>◈ CONTROL PANEL</SL>
            {isPython&&wsState!=="open"&&(
              <div style={{marginBottom:10,padding:"6px 9px",background:"rgba(255,204,0,.06)",border:"1px solid rgba(255,204,0,.2)",borderRadius:4,fontSize:8,color:"#ffcc00",lineHeight:1.6}}>
                ⚠ Backend offline.<br/>
                Run: <span style={{color:"#39ff14"}}>cd Backend</span><br/>
                <span style={{color:"#39ff14"}}>python -m uvicorn main:app --reload --port 8000</span>
              </div>
            )}
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
              {activeStatus==="idle"    &&<Btn color="#39ff14" onClick={doStart} disabled={isPython&&wsState!=="open"} key="btn-start">▶ START</Btn>}
              {activeStatus==="running" &&<Btn color="#ffcc00" key="btn-pause" onClick={()=>{
                if(isPython){ wsRef.current?.send(JSON.stringify({type:"pause"})); setPyStatus("paused"); }
                else pause();
                logPy(sim.simT,"⏸ Simulation paused","info");
              }}>⏸ PAUSE</Btn>}
              {activeStatus==="paused"  &&<Btn color="#00f5ff" key="btn-resume" onClick={()=>{
                if(isPython){ wsRef.current?.send(JSON.stringify({type:"resume"})); setPyStatus("running"); }
                else resume();
                logPy(sim.simT,"▶ Simulation resumed","info");
              }}>▶ RESUME</Btn>}
              <Btn color="#ff4444" key="btn-reset" onClick={()=>{
                if(isPython){ wsRef.current?.send(JSON.stringify({type:"reset"})); setPyStatus("idle"); }
                reset();
              }}>↺ RESET</Btn>
            </div>

            {/* Scheduler */}
            <SL style={{marginBottom:7}}>SCHEDULER ALGORITHM</SL>
            {["FIFO","RR","EDF"].map(a=>(
              <button key={a}
                onClick={()=>{setAlgo(a);if(isPython&&wsRef.current?.readyState===WebSocket.OPEN)wsRef.current.send(JSON.stringify({type:"config",algo:a}));}}
                onMouseEnter={()=>setHovTip(SCHED_DESC[a])}
                onMouseLeave={()=>setHovTip(null)}
                style={{display:"block",width:"100%",marginBottom:4,padding:"6px 10px",textAlign:"left",
                  background:algo===a?"rgba(0,245,255,.09)":"rgba(0,245,255,.02)",
                  border:`1px solid ${algo===a?"rgba(0,245,255,.42)":"rgba(0,245,255,.07)"}`,
                  color:algo===a?"#00f5ff":"#3a4a56",borderRadius:4,fontSize:11,
                  fontFamily:"Share Tech Mono,monospace"}}>
                {algo===a?"◆ ":"○ "}{a==="FIFO"?"First In First Out":a==="RR"?"Round Robin":"Earliest Deadline First"}
              </button>
            ))}
            <div style={{fontSize:8,color:"#384858",lineHeight:1.65,borderTop:"1px solid rgba(0,245,255,.05)",paddingTop:7,marginTop:6}}>
              {SCHED_DESC[algo]}
            </div>

            {/* Arrival rate */}
            <div style={{marginTop:12}}>
              <SL style={{marginBottom:5}}>ARRIVAL RATE: <span style={{color:"#ffcc00"}}>{rate} pkt/s</span></SL>
              <input type="range" min="0.5" max="7" step="0.5" value={rate} onChange={e=>setRate(+e.target.value)}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#1e2e3a",marginTop:2}}>
                <span>LOW</span><span>CONGESTION ⚠</span>
              </div>
            </div>
          </div>

          {/* Tooltip */}
          {hovTip&&(
            <div className="panel" style={{padding:11,borderColor:"rgba(255,204,0,.2)"}}>
              <SL style={{color:"#ffcc00"}}>◈ INFO</SL>
              <div style={{fontSize:8,color:"#5a6a7a",lineHeight:1.65}}>{hovTip}</div>
            </div>
          )}

          {/* ── CHANNEL NOISE PANEL ── */}
          <div className="panel" style={{padding:12}}>
            <SL>◈ CHANNEL NOISE</SL>
            <div style={{marginBottom:8,padding:"6px 9px",background:"rgba(255,136,0,.07)",border:"1px solid rgba(255,136,0,.2)",borderRadius:4}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:9,color:"#ff8800"}}>ERROR RATE</span>
                <span style={{fontFamily:"Orbitron",fontSize:16,color:noise>0.2?"#ff4444":noise>0?"#ff8800":"#39ff14"}}>
                  {(noise*100).toFixed(0)}%
                </span>
              </div>
              {/* Slider */}
              <input type="range" min="0" max="0.5" step="0.01" value={noise}
                onChange={e=>handleNoiseSlider(+e.target.value)}
                style={{accentColor:noise>0.2?"#ff4444":"#ff8800",width:"100%",marginBottom:6}}/>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                {/* Manual input */}
                <div style={{display:"flex",alignItems:"center",gap:4,flex:1}}>
                  <input
                    type="number" min="0" max="50" value={noiseInput}
                    onChange={e=>handleNoiseInput(e.target.value)}
                    style={{width:52,padding:"3px 6px",background:"rgba(255,136,0,.08)",
                      border:"1px solid rgba(255,136,0,.3)",borderRadius:3,
                      color:"#ff8800",fontSize:11,fontFamily:"Share Tech Mono",textAlign:"center"}}
                  />
                  <span style={{fontSize:9,color:"#3a4a5a"}}>%</span>
                </div>
                {/* Randomize */}
                <button onClick={randomizeNoise} style={{padding:"4px 9px",background:"rgba(168,85,247,.1)",
                  border:"1px solid rgba(168,85,247,.35)",color:"#a855f7",borderRadius:3,fontSize:9,
                  fontFamily:"Share Tech Mono",letterSpacing:1}}>
                  🎲 RANDOM
                </button>
              </div>
              <div style={{fontSize:7,color:"#3a4a5a",marginTop:5,lineHeight:1.6}}>
                {noise===0?"No channel errors — ideal conditions.":
                 noise<0.1?"Low noise — occasional retransmissions.":
                 noise<0.25?"Medium noise — noticeable packet loss.":
                 "High noise — significant retransmissions!"}
              </div>
            </div>
            {/* Retransmissions counter */}
            {metrics.retx>0&&(
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"5px 9px",background:"rgba(255,68,68,.06)",border:"1px solid rgba(255,68,68,.2)",borderRadius:4}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:"#ff4444",boxShadow:"0 0 6px #ff4444"}}/>
                <span style={{fontSize:9,color:"#ff4444"}}>Retransmissions: <strong>{metrics.retx}</strong></span>
              </div>
            )}
          </div>

          {/* UE Manager */}
          <div className="panel" style={{padding:12}}>
            <div style={{display:"flex",alignItems:"center",marginBottom:10}}>
              <SL style={{margin:0}}>◈ USER EQUIPMENT ({ues.length}/{MAX_UES})</SL>
              <div style={{marginLeft:"auto",display:"flex",gap:5}}>
                {/* + / - always available, even in Python mode before start */}
                <button onClick={addUE} disabled={ues.length>=MAX_UES||activeStatus==="running"}
                  style={{padding:"3px 10px",background:"rgba(57,255,20,.1)",border:"1px solid rgba(57,255,20,.35)",color:"#39ff14",borderRadius:3,fontSize:14,fontWeight:"bold",opacity:(ues.length>=MAX_UES||activeStatus==="running")?.3:1,cursor:(ues.length>=MAX_UES||activeStatus==="running")?"not-allowed":"pointer"}}>+</button>
                <button onClick={()=>removeUE(ues[ues.length-1].id)} disabled={ues.length<=1||activeStatus==="running"}
                  style={{padding:"3px 10px",background:"rgba(255,68,68,.1)",border:"1px solid rgba(255,68,68,.35)",color:"#ff4444",borderRadius:3,fontSize:14,fontWeight:"bold",opacity:(ues.length<=1||activeStatus==="running")?.3:1,cursor:(ues.length<=1||activeStatus==="running")?"not-allowed":"pointer"}}>−</button>
              </div>
            </div>

            {ues.map(ue=>{
              const act=activeUes.has(ue.id),qc=queue.filter(p=>(p.ueId??0)===ue.id).length;
              return(
                <div key={ue.id} className="ue-enter" style={{display:"flex",alignItems:"center",gap:7,marginBottom:7,padding:"6px 8px",background:act?`${ue.color}0c`:"transparent",border:`1px solid ${act?ue.color+"38":"transparent"}`,borderRadius:4,transition:"all .3s"}}>
                  <div style={{width:12,height:12,borderRadius:"50%",background:ue.color,boxShadow:`0 0 ${act?18:5}px ${ue.color}`,flexShrink:0,transition:"box-shadow .3s"}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:11,color:ue.color,fontFamily:"Orbitron",fontWeight:700}}>{ue.name}</div>
                    <div style={{fontSize:7,color:"#283848"}}>{qc} in queue</div>
                  </div>
                  {act&&<div className="blink" style={{fontSize:7,color:ue.color}}>◆TX</div>}
                  <button onClick={()=>removeUE(ue.id)} disabled={ues.length<=1||activeStatus==="running"}
                    style={{width:15,height:15,borderRadius:"50%",background:"rgba(255,68,68,.08)",border:"1px solid rgba(255,68,68,.2)",color:"#ff4444",fontSize:9,display:"flex",alignItems:"center",justifyContent:"center",padding:0,opacity:(ues.length<=1||activeStatus==="running")?.2:.65,flexShrink:0,cursor:(ues.length<=1||activeStatus==="running")?"not-allowed":"pointer"}}>×</button>
                </div>
              );
            })}
            <div style={{fontSize:7,color:"#1e2e3a",marginTop:4,lineHeight:1.65}}>
              {activeStatus!=="idle"?"Stop simulation to add/remove UEs.":"Add/remove before or after simulation."}
            </div>
          </div>

          {/* Lifecycle legend */}
          <div className="panel" style={{padding:12}}>
            <SL>◈ PACKET LIFECYCLE</SL>
            {[["gen","1. Generate","UE creates a packet"],["queue","2. Queue","Stored in BS buffer"],
              ["sched","3. Schedule","Algorithm selects it"],["tx","4. Transmit","Sent over channel"],
              ["rx","5. Receive","Arrives at destination"],["retx","↺ Retransmit","Lost in channel noise"],
              ["drop","⚠ Drop","Queue overflow — lost!"]].map(([t,lbl,desc])=>(
              <div key={t} style={{display:"flex",alignItems:"flex-start",gap:7,marginBottom:5}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:EV_C[t],marginTop:3,flexShrink:0,boxShadow:`0 0 5px ${EV_C[t]}`}}/>
                <div>
                  <div style={{fontSize:9,color:EV_C[t]}}>{lbl}</div>
                  <div style={{fontSize:7,color:"#243444"}}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ══ CENTER PANEL ════════════════════════════════ */}
        <div className="center-panel">
          {/* Network SVG */}
          <div className="panel grid-bg scanline" style={{flex:"1 1 0",position:"relative",overflow:"hidden",minHeight:0}}>
            <div style={{position:"absolute",top:8,left:12,fontSize:7,color:"rgba(0,245,255,.2)",letterSpacing:4,zIndex:2}}>◈ NETWORK TOPOLOGY</div>
            <div style={{position:"absolute",top:8,right:12,fontSize:7,zIndex:2}}>
              {isPython
                ? <span style={{color:"#39ff14"}}>🐍 PYTHON ENGINE</span>
                : <><span style={{color:"rgba(255,204,0,.3)"}}>SPEED </span><span style={{color:"#ffcc00"}}>{speed}×</span>
                   {noise>0&&<span style={{marginLeft:8,color:"#ff8800"}}>NOISE {(noise*100).toFixed(0)}%</span>}</>
              }
            </div>
            <NetSVG txPkt={txPkt} anims={anims} activeUes={activeUes} rxFlash={rxFlash}
                    algo={algo} ues={ues} uePosArr={uePosArr}
                    bsNode={BS} rxNode={RX} svgW={SVG_W} svgH={SVG_H}/>
          </div>

          {/* Queue buffer */}
          <div className="panel" style={{padding:12,flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:9}}>
              <SL style={{margin:0}}>◈ BASE STATION QUEUE BUFFER</SL>
              <div style={{marginLeft:"auto",fontSize:9,color:queueFull?"#ff4444":"#3a4a5a"}}>{queue.length}/{QUEUE_CAP}</div>
              {queueFull&&<div className="blink" style={{fontSize:8,color:"#ff4444"}}>⚠ FULL</div>}
            </div>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",minHeight:46}}>
              {Array.from({length:QUEUE_CAP}).map((_,i)=>{
                const p=queue[i],c=p?p.color:null,urgent=p&&algo==="EDF"&&((p.dl??99)-simT)<1;
                return(
                  <div key={i} title={p?`PKT#${p.id}|${p.name}|${p.sz}B`:"empty"}
                    style={{width:59,height:46,borderRadius:4,flexShrink:0,
                      border:`1px solid ${p?(urgent?"#ff4444":c):"rgba(0,245,255,.05)"}`,
                      background:p?(urgent?"#ff444413":`${c}11`):"rgba(0,245,255,.012)",
                      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                      fontSize:8,color:p?c:"#1a2a38",transition:"all .25s",animation:urgent?"blink .6s infinite":"none"}}>
                    {p?(<>
                      <div style={{fontWeight:700,fontSize:11}}>P{p.id}</div>
                      <div style={{fontSize:7,color:"#28384a"}}>{p.name}</div>
                      {algo==="EDF"&&<div style={{fontSize:6,color:urgent?"#ff4444":"#1e2e3e"}}>⏱{Math.max(0,(p.dl??0)-simT).toFixed(1)}s</div>}
                    </>):<div style={{fontSize:18,color:"#0b1a28"}}>□</div>}
                  </div>
                );
              })}
            </div>
            {txPkt
              ?<div style={{marginTop:7,padding:"5px 10px",borderRadius:4,background:`${txPkt.color}0c`,border:`1px solid ${txPkt.color}35`,display:"flex",alignItems:"center",gap:7}}>
                  <div className="blink" style={{width:7,height:7,borderRadius:"50%",background:txPkt.color}}/>
                  <span style={{fontSize:9,color:txPkt.color}}>TX: PKT #{txPkt.id} | {txPkt.name} | {txPkt.sz}B</span>
               </div>
              :<div style={{marginTop:6,fontSize:8,color:"#1a2e3e"}}>No active transmission</div>
            }
          </div>
        </div>

        {/* ══ RIGHT PANEL ═════════════════════════════════ */}
        <div className="right-panel">
          {/* Metrics */}
          <div className="panel" style={{padding:12,flexShrink:0}}>
            <SL>◈ LIVE METRICS</SL>
            <MC label="THROUGHPUT"       value={metrics.tp}    unit="pkt/s" color="#39ff14" tip="Delivered packets per second."                  onHover={setHovTip}/>
            <MC label="AVG DELAY"        value={metrics.delay}  unit="sec"  color="#00f5ff" tip="Mean time from generation to TX start."          onHover={setHovTip}/>
            <MC label="PKT DROPS"        value={metrics.drops}  unit=""     color="#ff4444" tip="Packets lost to queue overflow."                 onHover={setHovTip}/>
            <MC label="TX SUCCESS"       value={metrics.tx}     unit="pkts" color="#ffcc00" tip="Total packets successfully received."            onHover={setHovTip}/>
            <MC label="RETRANSMISSIONS"  value={metrics.retx??0} unit=""   color="#ff8800" tip="Packets re-sent due to channel noise/errors."    onHover={setHovTip}/>
          </div>

          {/* Charts */}
          {history.length>2&&(
            <div className="panel" style={{padding:12,flexShrink:0}}>
              <SL>◈ THROUGHPUT</SL>
              <ResponsiveContainer width="100%" height={56}>
                <AreaChart data={history} margin={{top:2,right:0,bottom:0,left:0}}>
                  <defs><linearGradient id="gTP" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#39ff14" stopOpacity={.35}/><stop offset="95%" stopColor="#39ff14" stopOpacity={0}/></linearGradient></defs>
                  <Area type="monotone" dataKey="tp" stroke="#39ff14" fill="url(#gTP)" strokeWidth={2} dot={false}/>
                  <Tooltip contentStyle={{background:"#020c1a",border:"1px solid #39ff1430",fontSize:8,fontFamily:"Share Tech Mono"}} formatter={v=>[`${v} pkt/s`,"tp"]}/>
                </AreaChart>
              </ResponsiveContainer>
              <SL style={{marginTop:10}}>◈ AVG DELAY</SL>
              <ResponsiveContainer width="100%" height={56}>
                <AreaChart data={history} margin={{top:2,right:0,bottom:0,left:0}}>
                  <defs><linearGradient id="gDL" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ff00aa" stopOpacity={.35}/><stop offset="95%" stopColor="#ff00aa" stopOpacity={0}/></linearGradient></defs>
                  <Area type="monotone" dataKey="d" stroke="#ff00aa" fill="url(#gDL)" strokeWidth={2} dot={false}/>
                  <Tooltip contentStyle={{background:"#020c1a",border:"1px solid #ff00aa30",fontSize:8,fontFamily:"Share Tech Mono"}} formatter={v=>[`${v}s`,"delay"]}/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Event log */}
          <div className="panel" style={{padding:12,flex:1,overflow:"hidden",display:"flex",flexDirection:"column",minHeight:0}}>
            <SL>◈ EVENT LOG <span style={{color:"#1a3040"}}>({events.length})</span></SL>
            <div style={{overflowY:"auto",flex:1}}>
              {events.length===0&&<div style={{fontSize:8,color:"#1a2e3e",marginTop:3}}>Press START to begin...</div>}
              {events.map(ev=>(
                <div key={ev.id} className="ev-row" style={{marginBottom:3,lineHeight:1.5}}>
                  <span style={{color:"#1a3040",fontSize:8}}>[{ev.t}] </span>
                  <span style={{color:EV_C[ev.type]??"#555",fontSize:8}}>{ev.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// COMPARE PAGE
// Two JS simulation engines run simultaneously with the same
// arrival rate, speed, noise and UE count but different algos.
// ═══════════════════════════════════════════════════════════
function ComparePage({ onBack }) {
  // Shared config
  const [sharedRate,  setSharedRate]  = useState(2);
  const [sharedSpeed, setSharedSpeed] = useState(1);
  const [sharedNoise, setSharedNoise] = useState(0);
  const [noiseInput,  setNoiseInput]  = useState("0");

  // Two independent simulation engines
  const simA = useJSSim("FIFO", true);
  const simB = useJSSim("EDF",  true);

  // Sync shared params into each engine via their setters
  useEffect(()=>{ simA.setRate(sharedRate); simB.setRate(sharedRate); },[sharedRate]);
  useEffect(()=>{ simA.setSpeed(sharedSpeed); simB.setSpeed(sharedSpeed); },[sharedSpeed]);
  useEffect(()=>{ simA.setNoise(sharedNoise); simB.setNoise(sharedNoise); },[sharedNoise]);

  // Keep UEs in sync — when one changes, copy to other
  const handleUEChange = useCallback((op) => {
    if(op==="add"){simA.addUE();simB.addUE();}
    else{
      // Remove last UE from both (both have same ids since they started from DEFAULT_UES)
      const lastId=simA.ues[simA.ues.length-1]?.id;
      if(lastId!==undefined){simA.removeUE(lastId);simB.removeUE(lastId);}
    }
  },[simA,simB]);

  const startBoth  = () => { simA.start();  simB.start();  };
  const pauseBoth  = () => { simA.pause();  simB.pause();  };
  const resumeBoth = () => { simA.resume(); simB.resume(); };
  const resetBoth  = () => { simA.reset();  simB.reset();  };

  const bothRunning = simA.status==="running"&&simB.status==="running";
  const bothPaused  = simA.status==="paused" &&simB.status==="paused";
  const bothIdle    = simA.status==="idle"   &&simB.status==="idle";

  const randomizeNoise = () => {
    const r = +(Math.random()*0.4).toFixed(2);
    setSharedNoise(r); setNoiseInput((r*100).toFixed(0));
  };

  // Winner logic
  const winner = (() => {
    const tA=simA.metrics.tp, tB=simB.metrics.tp;
    const dA=simA.metrics.delay, dB=simB.metrics.delay;
    if(tA===0&&tB===0) return null;
    const tpDiff = Math.abs(tA-tB)/(Math.max(tA,tB)||1);
    const dlDiff = Math.abs(dA-dB)/(Math.max(dA,dB)||1);
    if(tpDiff<0.05&&dlDiff<0.05) return "tie";
    // Score: higher TP is better, lower delay is better
    const scoreA = tA - dA*2;
    const scoreB = tB - dB*2;
    if(Math.abs(scoreA-scoreB)<0.05) return "tie";
    return scoreA>scoreB ? "A" : "B";
  })();

  // Comparison bar chart data
  const compareData = [
    { name:"Throughput", A:simA.metrics.tp, B:simB.metrics.tp },
    { name:"Avg Delay",  A:simA.metrics.delay, B:simB.metrics.delay },
    { name:"Drops",      A:simA.metrics.drops, B:simB.metrics.drops },
    { name:"Retx",       A:simA.metrics.retx??0, B:simB.metrics.retx??0 },
  ];

  return (
    <div style={{fontFamily:"'Share Tech Mono',monospace",background:"#030d1a",minHeight:"100vh",color:"#b8ccd8",overflow:"auto"}}>
      <GlobalStyles/>

      {/* ═══ COMPARE HEADER ═══════════════════════════════ */}
      <header className="app-header" style={{flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button onClick={onBack} style={{padding:"4px 10px",background:"rgba(0,245,255,.08)",border:"1px solid rgba(0,245,255,.25)",color:"#00f5ff",borderRadius:3,fontSize:10,fontFamily:"Share Tech Mono",cursor:"pointer"}}>← HOME</button>
          <div>
            <div className="brand" style={{fontSize:13}}>⬡ SCHEDULER COMPARISON</div>
            <div className="brand-sub">RUN TWO ALGORITHMS SIMULTANEOUSLY</div>
          </div>
        </div>

        {/* Shared config */}
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          {/* Rate */}
          <div>
            <div className="ctrl-label">RATE: <span style={{color:"#ffcc00"}}>{sharedRate}pkt/s</span></div>
            <input type="range" min="0.5" max="7" step="0.5" value={sharedRate}
              onChange={e=>setSharedRate(+e.target.value)}
              style={{width:90,accentColor:"#00f5ff"}}/>
          </div>
          {/* Speed */}
          <div>
            <div className="ctrl-label">SPEED</div>
            <div style={{display:"flex",gap:3}}>
              {SPEED_OPTS.map(s=>(
                <button key={s} className={`spd${sharedSpeed===s?" on":""}`} style={{width:30,fontSize:9}}
                  onClick={()=>setSharedSpeed(s)}>{s}×</button>
              ))}
            </div>
          </div>
          {/* Noise */}
          <div>
            <div className="ctrl-label">NOISE: <span style={{color:"#ff8800"}}>{(sharedNoise*100).toFixed(0)}%</span></div>
            <div style={{display:"flex",gap:5,alignItems:"center"}}>
              <input type="range" min="0" max="0.5" step="0.01" value={sharedNoise}
                onChange={e=>{setSharedNoise(+e.target.value);setNoiseInput(((+e.target.value)*100).toFixed(0));}}
                style={{width:70,accentColor:"#ff8800"}}/>
              <input type="number" min="0" max="50" value={noiseInput}
                onChange={e=>{const n=Math.min(50,Math.max(0,+e.target.value||0));setNoiseInput(String(n));setSharedNoise(+(n/100).toFixed(3));}}
                style={{width:42,padding:"2px 5px",background:"rgba(255,136,0,.08)",border:"1px solid rgba(255,136,0,.3)",borderRadius:3,color:"#ff8800",fontSize:10,fontFamily:"Share Tech Mono",textAlign:"center"}}/>
              <span style={{fontSize:8,color:"#3a4a5a"}}>%</span>
              <button onClick={randomizeNoise} style={{padding:"3px 7px",background:"rgba(168,85,247,.1)",border:"1px solid rgba(168,85,247,.3)",color:"#a855f7",borderRadius:3,fontSize:9,cursor:"pointer"}}>🎲</button>
            </div>
          </div>
          {/* UEs */}
          <div>
            <div className="ctrl-label">UEs: {simA.ues.length}/{MAX_UES}</div>
            <div style={{display:"flex",gap:4}}>
              <button onClick={()=>handleUEChange("add")} disabled={simA.ues.length>=MAX_UES||!bothIdle}
                style={{padding:"3px 9px",background:"rgba(57,255,20,.1)",border:"1px solid rgba(57,255,20,.3)",color:"#39ff14",borderRadius:3,fontSize:13,fontWeight:"bold",opacity:(simA.ues.length>=MAX_UES||!bothIdle)?.3:1,cursor:(simA.ues.length>=MAX_UES||!bothIdle)?"not-allowed":"pointer"}}>+</button>
              <button onClick={()=>handleUEChange("remove")} disabled={simA.ues.length<=1||!bothIdle}
                style={{padding:"3px 9px",background:"rgba(255,68,68,.1)",border:"1px solid rgba(255,68,68,.3)",color:"#ff4444",borderRadius:3,fontSize:13,fontWeight:"bold",opacity:(simA.ues.length<=1||!bothIdle)?.3:1,cursor:(simA.ues.length<=1||!bothIdle)?"not-allowed":"pointer"}}>−</button>
            </div>
          </div>
          {/* Controls */}
          <div style={{display:"flex",gap:6}}>
            {bothIdle    &&<Btn color="#39ff14" onClick={startBoth}>▶ START BOTH</Btn>}
            {bothRunning &&<Btn color="#ffcc00" onClick={pauseBoth}>⏸ PAUSE</Btn>}
            {bothPaused  &&<Btn color="#00f5ff" onClick={resumeBoth}>▶ RESUME</Btn>}
            <Btn color="#ff4444" onClick={resetBoth}>↺ RESET</Btn>
          </div>
          {/* Export both */}
          {(simA.history.length>0||simB.history.length>0)&&(
            <div style={{display:"flex",gap:4}}>
              <button onClick={()=>exportCSV({algo:simA.algo,rate:sharedRate,speed:sharedSpeed,noise:sharedNoise,numUes:simA.ues.length,history:simA.history,events:simA.events,metrics:simA.metrics,label:"A"})}
                style={{padding:"4px 9px",background:"rgba(57,255,20,.08)",border:"1px solid rgba(57,255,20,.3)",color:"#39ff14",borderRadius:3,fontSize:9,fontFamily:"Share Tech Mono",cursor:"pointer"}}>⬇ A</button>
              <button onClick={()=>exportCSV({algo:simB.algo,rate:sharedRate,speed:sharedSpeed,noise:sharedNoise,numUes:simB.ues.length,history:simB.history,events:simB.events,metrics:simB.metrics,label:"B"})}
                style={{padding:"4px 9px",background:"rgba(255,0,170,.08)",border:"1px solid rgba(255,0,170,.3)",color:"#ff00aa",borderRadius:3,fontSize:9,fontFamily:"Share Tech Mono",cursor:"pointer"}}>⬇ B</button>
            </div>
          )}
        </div>
      </header>

      {/* Winner banner */}
      {winner&&winner!=="tie"&&(simA.metrics.tx+simB.metrics.tx)>5&&(
        <div style={{textAlign:"center",padding:"6px",background:`rgba(57,255,20,.07)`,borderBottom:"1px solid rgba(57,255,20,.15)"}}>
          <span style={{fontFamily:"Orbitron",fontSize:11,color:"#39ff14",letterSpacing:3}}>
            ★ WINNER: SCHEDULER {winner} — {winner==="A"?simA.algo:simB.algo}
          </span>
          <span style={{fontSize:9,color:"#2a4a2a",marginLeft:10}}>based on throughput + delay score</span>
        </div>
      )}
      {winner==="tie"&&(simA.metrics.tx+simB.metrics.tx)>5&&(
        <div style={{textAlign:"center",padding:"6px",background:"rgba(255,204,0,.05)",borderBottom:"1px solid rgba(255,204,0,.1)"}}>
          <span style={{fontFamily:"Orbitron",fontSize:11,color:"#ffcc00",letterSpacing:3}}>≈ PERFORMANCE TIED</span>
        </div>
      )}

      {/* ═══ TWO SIDE-BY-SIDE PANELS ══════════════════════ */}
      <div className="compare-grid">
        <MiniSimPanel sim={simA} label="A" labelColor="#00f5ff"/>
        <div style={{width:1,background:"rgba(0,245,255,.06)",flexShrink:0}}/>
        <MiniSimPanel sim={simB} label="B" labelColor="#ff00aa"/>
      </div>

      {/* ═══ COMPARISON CHARTS ════════════════════════════ */}
      {(simA.metrics.tx+simB.metrics.tx)>2&&(
        <div className="panel" style={{margin:"0 8px 8px",padding:14}}>
          <SL>◈ PERFORMANCE COMPARISON — {simA.algo} (cyan) vs {simB.algo} (magenta)</SL>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            {/* Throughput comparison */}
            <div>
              <div style={{fontSize:8,color:"#2a3a4a",letterSpacing:2,marginBottom:6}}>THROUGHPUT (pkt/s) — higher is better</div>
              <ResponsiveContainer width="100%" height={100}>
                <BarChart data={[{name:"TP",A:simA.metrics.tp,B:simB.metrics.tp}]} margin={{top:4,right:4,bottom:0,left:0}}>
                  <Bar dataKey="A" name={simA.algo} radius={[3,3,0,0]}>
                    <Cell fill="#00f5ff" fillOpacity={0.8}/>
                  </Bar>
                  <Bar dataKey="B" name={simB.algo} radius={[3,3,0,0]}>
                    <Cell fill="#ff00aa" fillOpacity={0.8}/>
                  </Bar>
                  <Tooltip contentStyle={{background:"#020c1a",border:"1px solid #ffffff10",fontSize:8,fontFamily:"Share Tech Mono"}}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* Delay comparison */}
            <div>
              <div style={{fontSize:8,color:"#2a3a4a",letterSpacing:2,marginBottom:6}}>AVG DELAY (s) — lower is better</div>
              <ResponsiveContainer width="100%" height={100}>
                <BarChart data={[{name:"DL",A:simA.metrics.delay,B:simB.metrics.delay}]} margin={{top:4,right:4,bottom:0,left:0}}>
                  <Bar dataKey="A" radius={[3,3,0,0]}><Cell fill="#00f5ff" fillOpacity={0.8}/></Bar>
                  <Bar dataKey="B" radius={[3,3,0,0]}><Cell fill="#ff00aa" fillOpacity={0.8}/></Bar>
                  <Tooltip contentStyle={{background:"#020c1a",border:"1px solid #ffffff10",fontSize:8,fontFamily:"Share Tech Mono"}}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* Drops comparison */}
            <div>
              <div style={{fontSize:8,color:"#2a3a4a",letterSpacing:2,marginBottom:6}}>PKT DROPS — lower is better</div>
              <ResponsiveContainer width="100%" height={100}>
                <BarChart data={[{name:"DR",A:simA.metrics.drops,B:simB.metrics.drops}]} margin={{top:4,right:4,bottom:0,left:0}}>
                  <Bar dataKey="A" radius={[3,3,0,0]}><Cell fill="#00f5ff" fillOpacity={0.8}/></Bar>
                  <Bar dataKey="B" radius={[3,3,0,0]}><Cell fill="#ff00aa" fillOpacity={0.8}/></Bar>
                  <Tooltip contentStyle={{background:"#020c1a",border:"1px solid #ffffff10",fontSize:8,fontFamily:"Share Tech Mono"}}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* Retx comparison */}
            <div>
              <div style={{fontSize:8,color:"#2a3a4a",letterSpacing:2,marginBottom:6}}>RETRANSMISSIONS — lower is better</div>
              <ResponsiveContainer width="100%" height={100}>
                <BarChart data={[{name:"RX",A:simA.metrics.retx??0,B:simB.metrics.retx??0}]} margin={{top:4,right:4,bottom:0,left:0}}>
                  <Bar dataKey="A" radius={[3,3,0,0]}><Cell fill="#00f5ff" fillOpacity={0.8}/></Bar>
                  <Bar dataKey="B" radius={[3,3,0,0]}><Cell fill="#ff00aa" fillOpacity={0.8}/></Bar>
                  <Tooltip contentStyle={{background:"#020c1a",border:"1px solid #ffffff10",fontSize:8,fontFamily:"Share Tech Mono"}}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          {/* Legend */}
          <div style={{display:"flex",gap:16,marginTop:10,justifyContent:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <div style={{width:12,height:12,borderRadius:2,background:"#00f5ff",opacity:.8}}/>
              <span style={{fontSize:9,color:"#00f5ff"}}>A — {simA.algo}</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <div style={{width:12,height:12,borderRadius:2,background:"#ff00aa",opacity:.8}}/>
              <span style={{fontSize:9,color:"#ff00aa"}}>B — {simB.algo}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// MINI SIM PANEL (used inside ComparePage)
// ═══════════════════════════════════════════════════════════
function MiniSimPanel({ sim, label, labelColor }) {
  const { status,algo,setAlgo,queue,events,metrics,txPkt,anims,history,activeUes,rxFlash,simT,ues } = sim;
  const queueFull=queue.length>=QUEUE_CAP;
  const uePosArr=getUEPositions(ues.length,true);

  return (
    <div style={{flex:1,display:"flex",flexDirection:"column",gap:7,padding:8,minWidth:0}}>
      {/* Panel header */}
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:"rgba(2,16,36,.7)",border:`1px solid ${labelColor}22`,borderRadius:6}}>
        <div style={{fontFamily:"Orbitron",fontSize:16,fontWeight:900,color:labelColor,textShadow:`0 0 12px ${labelColor}`}}>{label}</div>
        <div style={{flex:1}}>
          <div style={{fontSize:8,color:labelColor,letterSpacing:2}}>SCHEDULER</div>
          <div style={{display:"flex",gap:4,marginTop:2}}>
            {["FIFO","RR","EDF"].map(a=>(
              <button key={a} onClick={()=>setAlgo(a)} style={{padding:"2px 8px",background:algo===a?`${labelColor}18`:"transparent",border:`1px solid ${algo===a?labelColor+"44":labelColor+"18"}`,color:algo===a?labelColor:labelColor+"44",borderRadius:3,fontSize:9,fontFamily:"Share Tech Mono",cursor:"pointer"}}>{a}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{fontSize:7,color:"#2a3a4a",letterSpacing:2}}>TIME</div>
          <div style={{fontFamily:"Orbitron",fontSize:12,color:"#ffcc00"}}>{simT.toFixed(1)}s</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:2}}>
          <MC label="TP"     value={metrics.tp}      unit="p/s" color="#39ff14" small onHover={()=>{}}/>
          <MC label="DELAY"  value={metrics.delay}   unit="s"   color="#00f5ff" small onHover={()=>{}}/>
          <MC label="DROPS"  value={metrics.drops}   unit=""    color="#ff4444" small onHover={()=>{}}/>
          <MC label="RETX"   value={metrics.retx??0} unit=""    color="#ff8800" small onHover={()=>{}}/>
        </div>
      </div>

      {/* Mini network SVG */}
      <div className="panel grid-bg" style={{position:"relative",height:200,overflow:"hidden",flexShrink:0}}>
        <div style={{position:"absolute",top:5,left:8,fontSize:6,color:labelColor,opacity:.4,letterSpacing:3,zIndex:2}}>NETWORK [{algo}]</div>
        <NetSVG txPkt={txPkt} anims={anims} activeUes={activeUes} rxFlash={rxFlash}
                algo={algo} ues={ues} uePosArr={uePosArr}
                bsNode={MINI_BS} rxNode={MINI_RX} svgW={MINI_W} svgH={MINI_H}/>
      </div>

      {/* Mini queue */}
      <div className="panel" style={{padding:8,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
          <SL style={{margin:0,fontSize:7}}>QUEUE</SL>
          <span style={{marginLeft:"auto",fontSize:8,color:queueFull?"#ff4444":"#2a3a4a"}}>{queue.length}/{QUEUE_CAP}</span>
          {queueFull&&<span className="blink" style={{fontSize:7,color:"#ff4444"}}>FULL</span>}
        </div>
        <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
          {Array.from({length:QUEUE_CAP}).map((_,i)=>{
            const p=queue[i],c=p?p.color:null;
            return(
              <div key={i} style={{width:42,height:34,borderRadius:3,flexShrink:0,
                border:`1px solid ${p?c:"rgba(0,245,255,.04)"}`,
                background:p?`${c}11`:"rgba(0,245,255,.01)",
                display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                fontSize:7,color:p?c:"#1a2a38"}}>
                {p?(<><div style={{fontWeight:700,fontSize:9}}>P{p.id}</div><div style={{fontSize:6,color:"#28384a"}}>{p.name}</div></>):<div style={{fontSize:13,color:"#0b1a28"}}>□</div>}
              </div>
            );
          })}
        </div>
        {txPkt&&(
          <div style={{marginTop:5,fontSize:7,color:txPkt.color}}>
            ◆ TX: PKT #{txPkt.id} | {txPkt.name}
          </div>
        )}
      </div>

      {/* Mini event log */}
      <div className="panel" style={{padding:8,flex:1,overflow:"hidden",display:"flex",flexDirection:"column",minHeight:80}}>
        <SL style={{margin:"0 0 5px",fontSize:7}}>EVENT LOG</SL>
        <div style={{overflowY:"auto",flex:1}}>
          {events.slice(0,30).map(ev=>(
            <div key={ev.id} className="ev-row" style={{marginBottom:2}}>
              <span style={{color:"#1a3040",fontSize:7}}>[{ev.t}] </span>
              <span style={{color:EV_C[ev.type]??"#555",fontSize:7}}>{ev.msg}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Mini history chart */}
      {history.length>2&&(
        <div className="panel" style={{padding:8,flexShrink:0}}>
          <SL style={{margin:"0 0 4px",fontSize:7}}>THROUGHPUT HISTORY</SL>
          <ResponsiveContainer width="100%" height={45}>
            <AreaChart data={history} margin={{top:2,right:0,bottom:0,left:0}}>
              <defs><linearGradient id={`gM${label}`} x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={labelColor} stopOpacity={.3}/><stop offset="95%" stopColor={labelColor} stopOpacity={0}/></linearGradient></defs>
              <Area type="monotone" dataKey="tp" stroke={labelColor} fill={`url(#gM${label})`} strokeWidth={1.5} dot={false}/>
              <Tooltip contentStyle={{background:"#020c1a",border:"1px solid #ffffff10",fontSize:7,fontFamily:"Share Tech Mono"}}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// NET SVG — parameterized for both full and mini sizes
// ═══════════════════════════════════════════════════════════
function NetSVG({ txPkt, anims, activeUes, rxFlash, algo, ues, uePosArr, bsNode, rxNode, svgW, svgH }) {
  return (
    <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{width:"100%",height:"100%"}}>
      <defs>
        <filter id="gCy"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <filter id="gAm"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <filter id="gSo"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>

      {/* Layer labels */}
      <text x={svgW*0.11} y={svgH-5} textAnchor="middle" fill="rgba(0,245,255,.06)" fontSize={6} fontFamily="Share Tech Mono">USER</text>
      <text x={svgW*0.5}  y={svgH-5} textAnchor="middle" fill="rgba(0,245,255,.06)" fontSize={6} fontFamily="Share Tech Mono">SCHEDULER</text>
      <text x={svgW*0.9}  y={svgH-5} textAnchor="middle" fill="rgba(255,204,0,.06)" fontSize={6} fontFamily="Share Tech Mono">NETWORK</text>
      <line x1={svgW*0.31} y1={0} x2={svgW*0.31} y2={svgH} stroke="rgba(0,245,255,.03)" strokeWidth={1} strokeDasharray="4 6"/>
      <line x1={svgW*0.71} y1={0} x2={svgW*0.71} y2={svgH} stroke="rgba(255,204,0,.03)"  strokeWidth={1} strokeDasharray="4 6"/>

      {/* UE → BS guide lines */}
      {ues.map((ue,idx)=>{
        const uep=uePosArr[idx]; if(!uep) return null;
        const act=activeUes.has(ue.id);
        const ueR=Math.max(12,Math.min(20,22-ues.length));
        return(
          <line key={ue.id}
            x1={uep.x+ueR} y1={uep.y} x2={bsNode.x-32} y2={bsNode.y}
            stroke={ue.color} strokeOpacity={act?.55:.12}
            strokeWidth={act?1.5:1} strokeDasharray="5 6"/>
        );
      })}

      {/* BS → RX guide line */}
      <line x1={bsNode.x+32} y1={bsNode.y} x2={rxNode.x-24} y2={rxNode.y}
        stroke={txPkt?txPkt.color:"rgba(255,204,0,.25)"}
        strokeOpacity={txPkt?.7:.28}
        strokeWidth={txPkt?2:1.2}
        strokeDasharray={txPkt?"none":"6 4"}/>

      {/* Animated packets */}
      {anims.map(a=><AnimPkt key={a.id} a={a}/>)}

      {/* UE Nodes */}
      {ues.map((ue,idx)=>{
        const uep=uePosArr[idx]; if(!uep)return null;
        const act=activeUes.has(ue.id),c=ue.color;
        const r=Math.max(12,Math.min(20,22-ues.length));
        return(
          <g key={ue.id} filter="url(#gSo)">
            {act&&(
              <circle cx={uep.x} cy={uep.y} r={r+10} fill="none" stroke={c} strokeWidth={1.5} strokeOpacity={0}>
                <animate attributeName="r"       values={`${r};${r+20}`} dur=".75s" repeatCount="1"/>
                <animate attributeName="opacity" values=".5;0"          dur=".75s" repeatCount="1"/>
              </circle>
            )}
            <circle cx={uep.x} cy={uep.y} r={r} fill={`${c}0b`} stroke={c} strokeWidth={act?2:1.5} strokeOpacity={act?1:.4}/>
            <rect x={uep.x-5} y={uep.y-8} width={10} height={14} rx={2} fill="none" stroke={c} strokeWidth={1.5} strokeOpacity={.75}/>
            <circle cx={uep.x} cy={uep.y+8} r={1.5} fill={c} fillOpacity={.6}/>
            <text x={uep.x} y={uep.y+r+10} textAnchor="middle" fill={c} fontSize={7} fontFamily="Share Tech Mono" opacity={.75}>{ue.name}</text>
          </g>
        );
      })}

      {/* Base Station */}
      <g filter="url(#gCy)">
        <rect x={bsNode.x-32} y={bsNode.y-38} width={64} height={76} rx={6} fill="rgba(0,245,255,.04)" stroke="#00f5ff" strokeWidth={1.5} strokeOpacity={.48}/>
        <line x1={bsNode.x} y1={bsNode.y-38} x2={bsNode.x}    y2={bsNode.y-62} stroke="#00f5ff" strokeWidth={2} strokeOpacity={.65}/>
        <line x1={bsNode.x-13} y1={bsNode.y-62} x2={bsNode.x+13} y2={bsNode.y-62} stroke="#00f5ff" strokeWidth={2} strokeOpacity={.65}/>
        <line x1={bsNode.x-8}  y1={bsNode.y-52} x2={bsNode.x+8}  y2={bsNode.y-52} stroke="#00f5ff" strokeWidth={1.5} strokeOpacity={.45}/>
        {[10,18,28].map(rv=><circle key={rv} cx={bsNode.x} cy={bsNode.y-62} r={rv} fill="none" stroke="#00f5ff" strokeWidth={.7} strokeOpacity={.1}/>)}
        <circle cx={bsNode.x+22} cy={bsNode.y-24} r={3}
          fill={txPkt?"#39ff14":"#0e2030"} style={{filter:txPkt?"drop-shadow(0 0 5px #39ff14)":"none"}}/>
        <text x={bsNode.x} y={bsNode.y+48} textAnchor="middle" fill="#00f5ff" fontSize={7} fontFamily="Share Tech Mono" opacity={.6}>gNB / BS</text>
        <text x={bsNode.x} y={bsNode.y+58} textAnchor="middle" fill="#ffcc00" fontSize={6} fontFamily="Share Tech Mono" opacity={.7}>[{algo}]</text>
      </g>

      {/* Receiver */}
      <g className={rxFlash?"rx-lit":""} filter="url(#gAm)">
        <rect x={rxNode.x-24} y={rxNode.y-30} width={48} height={60} rx={6}
          fill={rxFlash?"rgba(57,255,20,.1)":"rgba(255,204,0,.04)"}
          stroke={rxFlash?"#39ff14":"#ffcc00"}
          strokeWidth={1.5} strokeOpacity={rxFlash?.85:.45}/>
        {[-10,0,10].map(dy=>(
          <g key={dy}>
            <rect x={rxNode.x-14} y={rxNode.y+dy-4} width={28} height={8} rx={2} fill="none" stroke="#ffcc00" strokeWidth={1} strokeOpacity={.4}/>
            <circle cx={rxNode.x+10} cy={rxNode.y+dy} r={2} fill={rxFlash?"#39ff14":"#ffcc00"} fillOpacity={.6}/>
          </g>
        ))}
        <text x={rxNode.x} y={rxNode.y+42} textAnchor="middle" fill="#ffcc00" fontSize={7} fontFamily="Share Tech Mono" opacity={.6}>RX</text>
      </g>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════
// ANIMATED PACKET DOT
// ═══════════════════════════════════════════════════════════
function AnimPkt({ a }) {
  const path=buildPath(a.fx,a.fy,a.tx,a.ty);
  return(
    <g style={{filter:`drop-shadow(0 0 10px ${a.col})`}}>
      <animateMotion dur={`${a.ms}ms`} fill="freeze" path={path}/>
      <circle r={12} fill="none" stroke={a.col} strokeWidth={1} strokeOpacity={0.2}/>
      <circle r={8}  fill="none" stroke={a.col} strokeWidth={1} strokeOpacity={0.4}/>
      <circle r={5}  fill={a.col} fillOpacity={0.95}/>
      <text fontSize={6} fill={a.col} textAnchor="middle" dy={-16} fontFamily="Share Tech Mono" fontWeight="bold">{a.lbl}</text>
    </g>
  );
}

// ═══════════════════════════════════════════════════════════
// GLOBAL STYLES — includes responsive breakpoints
// ═══════════════════════════════════════════════════════════
function GlobalStyles() {
  return(
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&display=swap');

      @keyframes blink   {0%,100%{opacity:1}50%{opacity:.18}}
      @keyframes slideIn {from{opacity:0;transform:translateX(-7px)}to{opacity:1;transform:translateX(0)}}
      @keyframes rxPulse {0%,100%{filter:brightness(1)}50%{filter:brightness(2.8) drop-shadow(0 0 22px #39ff14)}}
      @keyframes scanBar {0%{top:-3px}100%{top:calc(100%+3px)}}
      @keyframes ueEnter {from{opacity:0;transform:scale(.55)}to{opacity:1;transform:scale(1)}}

      .blink    {animation:blink 1s infinite}
      .ev-row   {animation:slideIn .2s ease}
      .rx-lit   {animation:rxPulse .7s ease}
      .ue-enter {animation:ueEnter .4s cubic-bezier(.34,1.56,.64,1)}

      *{box-sizing:border-box;margin:0;padding:0}
      ::-webkit-scrollbar{width:3px}
      ::-webkit-scrollbar-thumb{background:rgba(0,245,255,.2);border-radius:2px}
      input[type=range]{width:100%}
      button{transition:all .13s;cursor:pointer}
      button:hover{opacity:.82;transform:translateY(-1px)}

      .panel{
        background:rgba(2,16,36,.88);
        border:1px solid rgba(0,245,255,.09);
        border-radius:8px;
        backdrop-filter:blur(12px);
      }
      .grid-bg{
        background-image:
          linear-gradient(rgba(0,245,255,.02) 1px,transparent 1px),
          linear-gradient(90deg,rgba(0,245,255,.02) 1px,transparent 1px);
        background-size:26px 26px;
      }
      .scanline{position:relative;overflow:hidden}
      .scanline::after{
        content:'';position:absolute;left:0;right:0;height:3px;
        background:linear-gradient(transparent,rgba(0,245,255,.05),transparent);
        animation:scanBar 5s linear infinite;pointer-events:none;z-index:1;
      }

      /* Speed buttons */
      .spd{
        padding:3px 0;border-radius:3px;font-size:9px;
        font-family:'Share Tech Mono',monospace;
        border:1px solid rgba(0,245,255,.13);
        background:rgba(0,245,255,.03);color:#3a5a6a;
        cursor:pointer;transition:all .13s;text-align:center;
      }
      .spd.on{background:rgba(0,245,255,.13);border-color:rgba(0,245,255,.45);color:#00f5ff;box-shadow:0 0 9px rgba(0,245,255,.12)}
      .spd:hover{color:#00f5ff;border-color:rgba(0,245,255,.28)}

      /* Mode buttons */
      .mode-btn{
        padding:4px 11px;border-radius:3px;font-size:9px;
        font-family:'Share Tech Mono',monospace;letter-spacing:1px;
        cursor:pointer;transition:all .13s;
        background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);color:#2a3a4a;
      }
      .mode-js{background:rgba(0,245,255,.08);border-color:rgba(0,245,255,.3);color:#00f5ff}
      .mode-py{background:rgba(57,255,20,.08);border-color:rgba(57,255,20,.3);color:#39ff14}

      /* Compare / CSV buttons */
      .compare-btn{
        padding:5px 11px;background:rgba(168,85,247,.1);border:1px solid rgba(168,85,247,.35);
        color:#a855f7;border-radius:4px;font-size:10px;font-family:'Share Tech Mono',monospace;letter-spacing:1px;
      }
      .csv-btn{
        padding:5px 11px;background:rgba(57,255,20,.1);border:1px solid rgba(57,255,20,.35);
        color:#39ff14;border-radius:4px;font-size:10px;font-family:'Share Tech Mono',monospace;letter-spacing:1px;
      }
      .csv-btn.disabled{background:rgba(57,255,20,.02);border-color:rgba(57,255,20,.07);color:#1e2e3e;cursor:default}

      /* Typography */
      .brand{font-family:Orbitron,sans-serif;font-size:15px;font-weight:900;color:#00f5ff;letter-spacing:4px;text-shadow:0 0 18px rgba(0,245,255,.5)}
      .brand-sub{font-size:7px;color:rgba(0,245,255,.27);letter-spacing:5px}
      .ctrl-label{font-size:7px;color:#1e2e3a;letter-spacing:2px;margin-bottom:3px}

      /* Header */
      .app-header{
        padding:8px 14px;
        border-bottom:1px solid rgba(0,245,255,.1);
        display:flex;align-items:center;justify-content:space-between;
        background:rgba(0,245,255,.01);
        gap:10px;
      }
      .header-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}

      /* Main grid — 3 columns on desktop */
      .main-grid{
        display:grid;
        grid-template-columns:252px 1fr 268px;
        gap:8px;padding:8px;
        height:calc(100vh - 50px);
      }
      .left-panel  {display:flex;flex-direction:column;gap:8px;overflow-y:auto}
      .center-panel{display:flex;flex-direction:column;gap:8px;overflow:hidden}
      .right-panel {display:flex;flex-direction:column;gap:8px;overflow:hidden}

      /* Compare grid */
      .compare-grid{display:flex;gap:0;padding:8px;min-height:0}

      /* ── RESPONSIVE ── */
      @media (max-width:1100px){
        .main-grid{grid-template-columns:220px 1fr 240px}
      }
      @media (max-width:880px){
        .main-grid{
          grid-template-columns:1fr 1fr;
          grid-template-rows:auto auto;
          height:auto;
          overflow:auto;
        }
        .center-panel{grid-column:1/-1;order:-1}
        .left-panel{overflow-y:visible}
        .right-panel{overflow:visible}
      }
      @media (max-width:600px){
        .main-grid{grid-template-columns:1fr;height:auto}
        .app-header{flex-direction:column;align-items:flex-start}
        .header-controls{gap:8px}
        .hide-sm{display:none}
        .compare-grid{flex-direction:column}
      }
    `}</style>
  );
}

// ═══════════════════════════════════════════════════════════
// SHARED UI ATOMS
// ═══════════════════════════════════════════════════════════
function SL({ children, style={} }) {
  return <div style={{fontSize:8,color:"rgba(0,245,255,.48)",letterSpacing:3,marginBottom:8,...style}}>{children}</div>;
}

function Btn({ children, color, onClick, disabled=false }) {
  return(
    <button onClick={onClick} disabled={disabled} style={{
      padding:"5px 12px",
      background:disabled?`${color}06`:`${color}15`,
      border:`1px solid ${disabled?color+"15":color+"55"}`,
      color:disabled?color+"30":color,
      borderRadius:4,fontSize:10,
      fontFamily:"Share Tech Mono,monospace",letterSpacing:1,
      opacity:disabled?.45:1,cursor:disabled?"not-allowed":"pointer",
    }}>{children}</button>
  );
}

function MC({ label, value, unit, color, tip, onHover, small=false }) {
  if(small){
    return(
      <div style={{display:"flex",alignItems:"center",gap:5,padding:"2px 0"}}>
        <span style={{fontSize:6,color:"#2a3a4a",letterSpacing:1,width:32}}>{label}</span>
        <span style={{fontFamily:"Orbitron",fontSize:11,color}}>{value}</span>
        {unit&&<span style={{fontSize:6,color:"#283848"}}>{unit}</span>}
      </div>
    );
  }
  return(
    <div title={tip} onMouseEnter={()=>tip&&onHover(tip)} onMouseLeave={()=>onHover(null)}
      style={{marginBottom:8,padding:"6px 9px",background:`${color}09`,border:`1px solid ${color}18`,borderRadius:4,cursor:tip?"help":"default"}}>
      <div style={{fontSize:7,color:"#2a3a4a",letterSpacing:2}}>{label}</div>
      <div style={{fontFamily:"Orbitron,sans-serif",fontSize:20,color,lineHeight:1.2}}>
        {value}<span style={{fontSize:7,color:"#283848",marginLeft:5}}>{unit}</span>
      </div>
    </div>
  );
}
