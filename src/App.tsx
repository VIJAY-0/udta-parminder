/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Volume2, VolumeX } from "lucide-react";

enum GameState {
  START,
  LOADING,
  PLAYING,
  CRASHING, // 2-second window: particles + sound play, no overlay yet
  GAMEOVER,
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

interface Obstacle {
  x: number;
  top: number;
  bottom: number;
  passed: boolean;
}

// ─── Robust Image Loader ────────────────────────────────────────────────────
// Tries multiple paths, retries on failure, caches in a ref.
function useRobustImage(paths: string[], retries = 3, retryDelay = 500) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const tryLoad = (pathIndex: number, attempt: number) => {
      if (pathIndex >= paths.length) return; // all paths exhausted
      const src = paths[pathIndex];

      const img = new Image();

      img.onload = () => {
        if (cancelled) return;
        imgRef.current = img;
        setLoaded(true);
      };

      img.onerror = () => {
        if (cancelled) return;
        if (attempt < retries) {
          setTimeout(() => tryLoad(pathIndex, attempt + 1), retryDelay);
        } else {
          // Try next path
          tryLoad(pathIndex + 1, 0);
        }
      };

      // Bust cache on retry attempts
      img.src = attempt > 0 ? `${src}?r=${attempt}` : src;
    };

    tryLoad(0, 0);
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return imgRef;
}

// ─── Robust Audio Manager ───────────────────────────────────────────────────
// Single AudioContext, pre-decoded buffers, never creates stale Audio elements.
class AudioManager {
  private ctx: AudioContext | null = null;
  private buffers: Map<string, AudioBuffer[]> = new Map();
  private bgSource: AudioBufferSourceNode | null = null;
  private bgGain: GainNode | null = null;
  public muted = false;

  private getCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return this.ctx;
  }

  async resume() {
    const ctx = this.getCtx();
    if (ctx.state === "suspended") await ctx.resume();
  }

  async preload(type: string, urls: string[]): Promise<void> {
    if (!urls.length) return;
    const ctx = this.getCtx();
    const loaded: AudioBuffer[] = [];

    await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await fetch(url);
          if (!res.ok) return;
          const arr = await res.arrayBuffer();
          const buf = await ctx.decodeAudioData(arr);
          loaded.push(buf);
        } catch {
          // silently skip unloadable files
        }
      })
    );

    if (loaded.length) this.buffers.set(type, loaded);
  }

  private pickBuffer(type: string): AudioBuffer | null {
    const bufs = this.buffers.get(type);
    if (!bufs || !bufs.length) return null;
    return bufs[Math.floor(Math.random() * bufs.length)];
  }

  playOnce(type: string, volume = 0.6) {
    if (this.muted) return;
    const buf = this.pickBuffer(type);
    if (!buf) { this.playTone(type); return; }

    const ctx = this.getCtx();
    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    src.start();
  }

  playBg(type: string, volume = 0.35) {
    this.stopBg();
    if (this.muted) return;
    const buf = this.pickBuffer(type);
    if (!buf) { this.playTone(type, true); return; }

    const ctx = this.getCtx();
    this.bgGain = ctx.createGain();
    this.bgGain.gain.value = volume;
    this.bgGain.connect(ctx.destination);

    this.bgSource = ctx.createBufferSource();
    this.bgSource.buffer = buf;
    this.bgSource.loop = true;
    this.bgSource.connect(this.bgGain);
    this.bgSource.start();
  }

  stopBg() {
    try { this.bgSource?.stop(); } catch { /* already stopped */ }
    this.bgSource = null;
    this.bgGain = null;
  }

  // Procedural tones as fallback when no audio files exist
  private toneHandles: Map<string, OscillatorNode> = new Map();

  private playTone(type: string, loop = false) {
    if (this.muted) return;

    if (type === "gameover") {
      // Dramatic descending sequence: three notes over ~1.8s
      const ctx = this.getCtx();
      const notes = [
        { freq: 523, start: 0,    dur: 0.5 },
        { freq: 349, start: 0.5,  dur: 0.5 },
        { freq: 220, start: 1.0,  dur: 0.9 },
      ];
      notes.forEach(({ freq, start, dur }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.35, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur + 0.05);
      });
      return;
    }

    const ctx = this.getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const configs: Record<string, { freq: number; type: OscillatorType; dur: number; vol: number }> = {
      click: { freq: 880, type: "square",   dur: 0.05, vol: 0.15 },
      start: { freq: 440, type: "triangle", dur: 0.4,  vol: 0.25 },
      bg:    { freq: 160, type: "triangle", dur: 0.5,  vol: 0.08 },
    };

    const cfg = configs[type] ?? { freq: 440, type: "sine" as OscillatorType, dur: 0.2, vol: 0.15 };
    osc.type = cfg.type;
    osc.frequency.value = cfg.freq;
    gain.gain.setValueAtTime(cfg.vol, ctx.currentTime);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();

    if (loop) {
      this.toneHandles.get(type)?.stop();
      this.toneHandles.set(type, osc);
    } else {
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + cfg.dur);
      osc.stop(ctx.currentTime + cfg.dur + 0.01);
    }
  }

  stopTone(type: string) {
    try { this.toneHandles.get(type)?.stop(); } catch { /* ok */ }
    this.toneHandles.delete(type);
  }

  destroy() {
    this.stopBg();
    this.ctx?.close();
    this.ctx = null;
  }
}

// ─── App ────────────────────────────────────────────────────────────────────
export default function App() {
  const [gameState, setGameState] = useState<GameState>(GameState.START);
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(() =>
    Number(localStorage.getItem("heli_high_score") || 0)
  );
  const [isMuted, setIsMuted] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });

  // Audio
  const audio = useRef(new AudioManager());
  useEffect(() => {
    audio.current.muted = isMuted;
    if (isMuted) audio.current.stopBg();
  }, [isMuted]);

  // Pre-load audio files — fetch from static manifest (Vercel/Static) or API (Local)
  useEffect(() => {
    const mgr = audio.current;
    (async () => {
      try {
        // Try static manifest first (best for Vercel/Production)
        let res = await fetch("/audio-manifest.json");
        if (!res.ok) {
          // Fallback to local API
          res = await fetch("/api/audio");
        }
        
        if (!res.ok) return;
        const data: Record<string, string[]> = await res.json();
        await Promise.all(
          Object.entries(data).map(([type, urls]) => mgr.preload(type, urls))
        );
      } catch { /* no audio endpoint – tones will be used */ }
    })();
    return () => mgr.destroy();
  }, []);

  // Pilot image — try standard production paths
  const faceImgRef = useRobustImage([
    "/assets/pilot.png",
    "/pilot.png",
  ]);

  // Canvas-drawn fallback avatar (drawn once into an offscreen canvas)
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const fc = document.createElement("canvas");
    fc.width = 60; fc.height = 60;
    const fctx = fc.getContext("2d")!;
    fctx.fillStyle = "#ffa502";
    fctx.beginPath();
    fctx.roundRect(0, 0, 60, 60, 8);
    fctx.fill();
    fctx.strokeStyle = "#2f3542";
    fctx.lineWidth = 3;
    fctx.stroke();
    fctx.fillStyle = "#2f3542";
    fctx.font = "bold 14px sans-serif";
    fctx.textAlign = "center";
    fctx.textBaseline = "middle";
    fctx.fillText("PILOT", 30, 30);
    fallbackCanvasRef.current = fc;
  }, []);

  // Game state refs
  const heli = useRef({ x: 100, y: 250, velocity: 0, angle: 0, spin: 0, width: 60, height: 60 });
  const crashParticles = useRef<Particle[]>([]);
  const obstacles = useRef<Obstacle[]>([]);
  const isHolding = useRef(false);
  const frameCount = useRef(0);
  const screenShake = useRef(0);
  const hasCrashed = useRef(false); // guard against double-crash during CRASHING state
  const scoreRef = useRef(0);

  // Keep scoreRef in sync
  useEffect(() => { scoreRef.current = score; }, [score]);

  const gravity = 0.25;
  const lift = -4.5;
  const OBS_W = 70;
  const GAP_RATIO = 0.55;

  // Resize
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        setSize({ w: containerRef.current.clientWidth, h: containerRef.current.clientHeight });
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const spawnObstacle = useCallback((width: number, height: number) => {
    const gap = height * GAP_RATIO;
    const minH = 50;
    const maxH = height - gap - minH;
    const topH = Math.random() * (maxH - minH) + minH;
    obstacles.current.push({ x: width, top: topH, bottom: height - (topH + gap), passed: false });
  }, []);

  const crash = useCallback(() => {
    if (hasCrashed.current) return;
    hasCrashed.current = true;

    // Step 1: switch to CRASHING — canvas keeps running, no overlay yet
    setGameState(GameState.CRASHING);
    screenShake.current = 15;
    audio.current.stopBg();
    audio.current.stopTone("bg");
    audio.current.playOnce("gameover"); // ~1.8s dramatic sequence

    setHighScore((prev) => {
      const newHigh = Math.max(prev, scoreRef.current);
      localStorage.setItem("heli_high_score", newHigh.toString());
      return newHigh;
    });

    heli.current.spin = 0.3;
    const colors = ["#ff4757", "#ffa502", "#2ed573", "#ffffff"];
    for (let i = 0; i < 60; i++) {
      crashParticles.current.push({
        x: heli.current.x + heli.current.width / 2,
        y: heli.current.y + heli.current.height / 2,
        vx: (Math.random() - 0.5) * 14,
        vy: (Math.random() - 0.5) * 14,
        life: 1,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }

    // Step 2: show GAMEOVER overlay after 2 seconds
    setTimeout(() => {
      setGameState(GameState.GAMEOVER);
    }, 2000);
  }, []);

  // Main game loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;

    const update = () => {
      if (gameState === GameState.GAMEOVER || gameState === GameState.CRASHING) {
        if (heli.current.spin > 0) {
          heli.current.angle += heli.current.spin;
          heli.current.spin *= 0.98;
        }
        heli.current.velocity += gravity;
        heli.current.y += heli.current.velocity;
      } else if (gameState === GameState.PLAYING) {
        heli.current.velocity += gravity;
        if (isHolding.current) heli.current.velocity += lift * 0.25;
        heli.current.y += heli.current.velocity;
        heli.current.angle = Math.max(-0.4, Math.min(0.4, heli.current.velocity * 0.05));

        obstacles.current.forEach((obs) => {
          obs.x -= 4;
          if (!obs.passed && obs.x + OBS_W < heli.current.x) {
            obs.passed = true;
            setScore((s) => s + 1);
          }
        });
        obstacles.current = obstacles.current.filter((o) => o.x > -OBS_W);

        if (frameCount.current % 100 === 0) spawnObstacle(canvas.width, canvas.height);

        const hx = heli.current.x + 10;
        const hy = heli.current.y + 10;
        const hw = heli.current.width - 20;
        const hh = heli.current.height - 20;

        for (const obs of obstacles.current) {
          if (
            hx < obs.x + OBS_W && hx + hw > obs.x &&
            (hy < obs.top || hy + hh > canvas.height - obs.bottom)
          ) { crash(); break; }
        }

        if (heli.current.y < -50 || heli.current.y > canvas.height + 50) crash();
      }

      crashParticles.current.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.1; p.life -= 0.015;
      });
      crashParticles.current = crashParticles.current.filter((p) => p.life > 0);

      if (screenShake.current > 0) {
        screenShake.current *= 0.9;
        if (screenShake.current < 0.1) screenShake.current = 0;
      }

      frameCount.current++;
    };

    const draw = () => {
      ctx.save();
      if (screenShake.current > 0) {
        ctx.translate(
          (Math.random() - 0.5) * screenShake.current,
          (Math.random() - 0.5) * screenShake.current
        );
      }

      // Sky
      ctx.fillStyle = "#70a1ff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const rg = ctx.createRadialGradient(canvas.width * 0.1, canvas.height * 0.2, 0, canvas.width * 0.1, canvas.height * 0.2, canvas.width * 0.4);
      rg.addColorStop(0, "rgba(255,255,255,0.2)");
      rg.addColorStop(1, "transparent");
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Clouds
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      const drawCloud = (x: number, y: number, w: number) => {
        ctx.beginPath();
        ctx.roundRect(x, y, w, 40, 20);
        ctx.fill();
      };
      const co = (frameCount.current * 0.5) % (canvas.width + 200);
      drawCloud(400 - co, 50, 120); drawCloud(700 - co, 120, 120);
      drawCloud(200 - co, 250, 160); drawCloud(900 - co, 80, 140);

      // Obstacles
      obstacles.current.forEach((obs) => {
        ctx.fillStyle = "#ff4757";
        ctx.strokeStyle = "#2f3542";
        ctx.lineWidth = 4;
        ctx.fillRect(obs.x, 0, OBS_W, obs.top);
        ctx.strokeRect(obs.x, -4, OBS_W, obs.top + 4);
        ctx.fillRect(obs.x, canvas.height - obs.bottom, OBS_W, obs.bottom);
        ctx.strokeRect(obs.x, canvas.height - obs.bottom, OBS_W, obs.bottom + 4);
      });

      // Heli
      ctx.save();
      ctx.translate(heli.current.x + heli.current.width / 2, heli.current.y + heli.current.height / 2);
      ctx.rotate(heli.current.angle);

      // Face / avatar
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-30, -30, 60, 60, 8);
      ctx.clip();

      const face = faceImgRef.current;
      if (face && face.complete && face.naturalWidth > 0) {
        const s = Math.min(face.width, face.height);
        const sx = (face.width - s) / 2;
        const sy = (face.height - s) / 3;
        ctx.drawImage(face, sx, sy, s, s, -30, -30, 60, 60);
      } else if (fallbackCanvasRef.current) {
        ctx.drawImage(fallbackCanvasRef.current, -30, -30, 60, 60);
      }
      ctx.restore();

      // Bamboo copter
      ctx.save();
      ctx.translate(0, -30);
      ctx.fillStyle = "#ffd32a";
      ctx.strokeStyle = "#2f3542";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-6, -8, 12, 10, 2);
      ctx.fill();
      ctx.stroke();

      ctx.save();
      ctx.translate(0, -8);
      ctx.rotate(frameCount.current * 0.6);
      ctx.beginPath();
      ctx.roundRect(-25, -2, 50, 4, 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      ctx.restore();

      ctx.restore(); // heli

      // Particles
      crashParticles.current.forEach((p) => {
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 * p.life, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#2f3542";
        ctx.lineWidth = 1;
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
      ctx.restore();
    };

    const loop = () => { update(); draw(); animId = requestAnimationFrame(loop); };
    loop();
    return () => cancelAnimationFrame(animId);
  }, [gameState, spawnObstacle, crash]);

  const handleStart = useCallback(() => {
    // Resume AudioContext (required after user gesture)
    audio.current.resume().then(() => {
      audio.current.playOnce("start", 0.5);
    });

    setGameState(GameState.LOADING);
    setTimeout(() => {
      setScore(0);
      scoreRef.current = 0;
      hasCrashed.current = false;
      heli.current = { x: 100, y: size.h / 2, velocity: 0, angle: 0, spin: 0, width: 60, height: 60 };
      obstacles.current = [];
      crashParticles.current = [];
      frameCount.current = 0;
      setGameState(GameState.PLAYING);
      audio.current.playBg("bg");
    }, 2000);
  }, [size.h]);

  const handleInteraction = useCallback(() => {
    if (gameState === GameState.PLAYING) {
      isHolding.current = true;
      audio.current.playOnce("click", 0.4);
    }
  }, [gameState]);

  return (
    <div className="fixed inset-0 bg-[#6366f1] flex flex-col font-sans overflow-hidden">
      <div className="flex-1 flex flex-col relative w-full h-full">
        {/* Header */}
        <header className="h-14 md:h-20 px-4 md:px-10 flex items-center justify-between bg-[#2f3542] text-white z-20">
          <div className="flex items-center gap-2 md:gap-3 text-lg md:text-[28px] font-black tracking-tighter">
            <span>🚁</span>
            <span className="hidden sm:inline">HELI-FACE ARCADE</span>
            <span className="sm:hidden uppercase">HELI-FACE</span>
          </div>
          <div className="flex items-center gap-2 md:gap-8 text-sm md:text-xl font-bold">
            <div className="bg-white/10 px-3 md:px-5 py-1 md:py-2 rounded-full">
              S: <span className="text-[#2ed573] font-mono">{score.toLocaleString("en-US", { minimumIntegerDigits: 3 })}</span>
            </div>
            <div className="bg-white/10 px-3 md:px-5 py-1 md:py-2 rounded-full">
              B: <span className="text-[#ffa502] font-mono">{highScore.toLocaleString("en-US", { minimumIntegerDigits: 3 })}</span>
            </div>
            <button onClick={() => setIsMuted((m) => !m)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
              {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
          </div>
        </header>

        {/* Game Viewport */}
        <div
          ref={containerRef}
          className="flex-1 relative bg-[#70a1ff] overflow-hidden touch-none"
          onMouseDown={handleInteraction}
          onMouseUp={() => (isHolding.current = false)}
          onMouseLeave={() => (isHolding.current = false)}
          onTouchStart={handleInteraction}
          onTouchEnd={() => (isHolding.current = false)}
        >
          <canvas ref={canvasRef} width={size.w} height={size.h} className="w-full h-full block" />

          <AnimatePresence mode="wait">
            {gameState === GameState.START && (
              <motion.div key="start" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/40 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center z-30">
                <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
                  className="w-full max-w-sm bg-white p-6 md:p-10 rounded-[24px] md:rounded-[32px] border-4 md:border-8 border-[#2f3542] shadow-[0_10px_0_rgba(0,0,0,0.1)]">
                  <h2 className="text-2xl md:text-4xl font-black mb-2 md:mb-4 uppercase tracking-tighter text-[#2f3542]">Ready to Fly?</h2>
                  <p className="text-[#2f3542] mb-6 md:mb-8 font-bold opacity-70 text-sm md:text-base">
                    Fly with the Bamboo Copter! Hold to fly up, release to fall.
                  </p>
                  <button onClick={handleStart}
                    className="w-full py-3 md:py-4 bg-[#2ed573] hover:bg-[#26c167] text-white rounded-xl md:rounded-2xl font-black text-xl md:text-2xl border-b-[4px] md:border-b-[6px] border-[#21a455] transition-all active:translate-y-1 active:border-b-0">
                    START MISSION
                  </button>
                </motion.div>
              </motion.div>
            )}

            {gameState === GameState.LOADING && (
              <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/60 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center z-30">
                <div className="text-white">
                  <div className="text-6xl mb-4 animate-bounce">🎋</div>
                  <h2 className="text-3xl font-black uppercase tracking-widest italic">GET READY!</h2>
                </div>
              </motion.div>
            )}

            {gameState === GameState.GAMEOVER && (
              <motion.div key="gameover" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/60 backdrop-blur-md flex flex-col items-center justify-center p-4 text-center z-30">
                <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                  className="w-full max-w-sm bg-white p-6 md:p-10 rounded-[24px] md:rounded-[32px] border-4 md:border-8 border-[#2f3542] shadow-[0_10px_0_rgba(0,0,0,0.1)]">
                  <h2 className="text-3xl md:text-5xl font-black mb-2 uppercase tracking-tighter text-[#ff4757]">Mission Failed</h2>
                  <p className="text-[#2f3542] font-bold opacity-60 mb-6 md:mb-8 text-sm md:text-base">You crashed into the obstacles!</p>
                  <div className="grid grid-cols-2 gap-4 md:gap-8 mb-6 md:mb-10">
                    <div className="flex flex-col">
                      <span className="text-[10px] md:text-xs uppercase tracking-widest text-[#2f3542] font-black opacity-40">Score</span>
                      <span className="text-2xl md:text-4xl font-black text-[#2f3542]">{score}</span>
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[10px] md:text-xs uppercase tracking-widest text-[#2f3542] font-black opacity-40">Best</span>
                      <span className="text-2xl md:text-4xl font-black text-[#ffa502]">{highScore}</span>
                    </div>
                  </div>
                  <button onClick={handleStart}
                    className="w-full py-3 md:py-4 bg-[#2ed573] hover:bg-[#26c167] text-white rounded-xl md:rounded-2xl font-black text-xl md:text-2xl border-b-[4px] md:border-b-[6px] border-[#21a455] transition-all active:translate-y-1 active:border-b-0">
                    START MISSION
                  </button>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="absolute bottom-20 md:bottom-5 left-1/2 -translate-x-1/2 bg-black/40 text-white px-4 md:px-5 py-1 rounded-full text-[10px] md:text-sm font-bold pointer-events-none whitespace-nowrap">
            HOLD TO FLY UP
          </div>
        </div>

        {/* Control Panel */}
        <div className="h-16 md:h-[120px] bg-[#f1f2f6] border-t-[4px] border-[#2f3542] flex items-center justify-around px-4 md:px-10 z-20">
          <div className="flex items-center gap-2 md:gap-4 bg-white px-3 md:px-5 py-1 md:py-3 rounded-lg md:rounded-[20px] border-2 border-solid border-[#ced4da]">
            <div className="text-lg md:text-3xl">🎋</div>
            <div>
              <div className="font-black text-[10px] md:text-sm text-[#2f3542]">BAMBOO COPTER</div>
              <div className="hidden md:block text-xs text-gray-400 font-bold">Mission in progress...</div>
            </div>
          </div>

          {gameState !== GameState.PLAYING && gameState !== GameState.LOADING && gameState !== GameState.CRASHING && (
            <button onClick={handleStart}
              className="px-4 md:px-10 py-2 md:py-4 bg-[#2ed573] hover:bg-[#26c167] text-white rounded-lg md:rounded-2xl font-black text-sm md:text-2xl border-b-[3px] md:border-b-[6px] border-[#21a455] transition-all active:translate-y-1 active:border-b-0">
              START
            </button>
          )}

          <div className="flex gap-2">
            <div className="hidden sm:flex w-8 md:w-12 h-8 md:h-12 bg-[#ddd] border-b-2 md:border-b-4 border-gray-400 rounded-lg md:rounded-xl items-center justify-center font-black text-[10px] md:text-xs text-[#666]">ESC</div>
            <div className="hidden sm:flex w-8 md:w-12 h-8 md:h-12 bg-[#ddd] border-b-2 md:border-b-4 border-gray-400 rounded-lg md:rounded-xl items-center justify-center font-black text-[10px] md:text-xs text-[#666]">P</div>
          </div>
        </div>
      </div>
    </div>
  );
}