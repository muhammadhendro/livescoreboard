import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import {
  Crown,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Timer,
  Activity,
  Zap,
  Trophy,
  Signal,
  Flame,
  Star,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import { LineChart, Line, ResponsiveContainer } from "recharts";

/**
 * Live CTF Scoreboard – Esports Style (Dynamic, Flashy)
 * ----------------------------------------------------
 * Drop-in React component for showcasing a live scoreboard with:
 *  - Animated rank changes (up/down)
 *  - Momentum sparkline per team (based on snapshots)
 *  - Neon/pro glass UI, OBS overlay mode, ticker for recent solves
 *  - API polling (default /api/v1/scoreboard) + optional WebSocket
 *
 * URL Params (optional):
 *  - endpoint:   API endpoint (default: /api/v1/scoreboard)
 *  - interval:   polling interval ms (default: 5000)
 *  - limit:      top N teams to show (default: 10)
 *  - overlay:    1 = transparent background + compact header hidden
 *  - ws:         WebSocket URL for push updates (message body => scoreboard)
 *
 * Expected API shapes supported (auto-adapt):
 *  A) CTFd-like: { success: true, data: [ { pos, name, score, account_id? } ] }
 *  B) Generic:   [ { rank|pos|place, name|team|account_name, score|points, id|team_id|account_id } ]
 *
 * If the endpoint is unreachable, the component falls back to demo data.
 */

function useQuery() {
  const [params] = useState(
    () =>
      new URLSearchParams(
        typeof window !== "undefined" ? window.location.search : ""
      )
  );
  return (key, fallback) => params.get(key) ?? fallback;
}

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

const neonGrad =
  "bg-gradient-to-br from-cyan-500/30 via-fuchsia-500/20 to-amber-500/30";
const glassEffect = "backdrop-blur-xl bg-white/5 border border-white/10";
const glowEffect = "shadow-2xl shadow-cyan-500/20";
const modernGrad =
  "bg-gradient-to-br from-slate-900/90 via-slate-800/80 to-slate-900/90";

// Global history storage for Spark (accessible across rows)
if (typeof window !== "undefined" && !window.__scoreHistory) {
  window.__scoreHistory = new Map(); // id -> [{t,score}]
}

export default function LiveCTFScoreboard() {
  const q = useQuery();
  const endpoint = q("endpoint", "/api/v1/scoreboard");
  const overlay = q("overlay", "0") === "1";
  const limit = parseInt(q("limit", "10"), 10);
  const interval = parseInt(q("interval", "5000"), 10);
  const wsUrl = q("ws", "");

  const [teams, setTeams] = useState([]); // normalized rows
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ticker, setTicker] = useState([]); // textual events of score ups

  // Keep historical scores per team for sparkline (in-memory + mirror window.__scoreHistory)
  const historyRef = useRef(new Map()); // id -> [{t,score}]
  const prevRanksRef = useRef(new Map()); // id -> prevRank
  const prevScoresRef = useRef(new Map()); // id -> prevScore

  // Mirror internal history into global map on each render
  useEffect(() => {
    if (typeof window === "undefined") return;
    for (const [id, arr] of historyRef.current.entries()) {
      window.__scoreHistory.set(id, arr);
    }
  });

  // Fetcher: supports CTFd-like and generic array payloads
  const parsePayload = (raw) => {
    const arr = Array.isArray(raw)
      ? raw
      : raw?.data ?? raw?.scoreboard ?? raw?.standings ?? [];
    if (!Array.isArray(arr)) return [];

    const norm = arr.map((it, idx) => {
      const id =
        it.id ??
        it.account_id ??
        it.team_id ??
        it.accountid ??
        it.teamid ??
        it.name ??
        `row-${idx}`;
      const name =
        it.name ??
        it.team ??
        it.account_name ??
        it.display_name ??
        `Team ${idx + 1}`;
      const score = Number(it.score ?? it.points ?? 0) || 0;
      const pos = Number(it.rank ?? it.pos ?? it.place ?? 0) || 0;
      return { id: String(id), name: String(name), score, pos };
    });

    // If no pos provided, compute by sorting desc score
    const ranked = [...norm]
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, pos: r.pos || i + 1 }));
    return ranked;
  };

  const pushHistory = (rows) => {
    const now = Date.now();
    rows.forEach((r) => {
      const h = historyRef.current.get(r.id) ?? [];
      const last = h[h.length - 1];
      if (!last || last.score !== r.score) {
        const next = [...h, { t: now, score: r.score }].slice(-30);
        historyRef.current.set(r.id, next);
        if (typeof window !== "undefined") {
          window.__scoreHistory.set(r.id, next);
        }
      }
    });
  };

  const updateTicker = (rows) => {
    const items = [];
    rows.forEach((r) => {
      const prevScore = prevScoresRef.current.get(r.id) ?? 0;
      if (r.score > prevScore) {
        const delta = r.score - prevScore;
        items.push({
          id: `${r.id}-${Date.now()}`,
          text: `${r.name} +${delta} pts`,
          when: new Date(),
        });
      }
      prevScoresRef.current.set(r.id, r.score);
    });
    if (items.length) setTicker((old) => [...items, ...old].slice(0, 30));
  };

  const materialize = (rows) => {
    // Re-rank by score desc to reflect fresh ordering
    const ordered = [...rows]
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    // Merge previous rank for movement indicator
    const withMovement = ordered.map((r) => {
      const prevRank = prevRanksRef.current.get(r.id) ?? r.rank;
      prevRanksRef.current.set(r.id, r.rank);
      return { ...r, prevRank, move: prevRank - r.rank }; // positive => moved up
    });
    return withMovement;
  };

  const fetchScoreboard = async () => {
    try {
      setError("");
      const res = await fetch(endpoint, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      const parsed = parsePayload(json);
      if (!parsed.length) throw new Error("Empty scoreboard data");
      pushHistory(parsed);
      updateTicker(parsed);
      const rows = materialize(parsed);
      setTeams(rows);
      setLastUpdated(new Date());
      setLoading(false);
    } catch (e) {
      console.warn("Scoreboard fetch error:", e);
      setError(String(e?.message || e));
      setLoading(false);
      // Fall back to demo data so the UI remains lively
      const demo = buildDemoData();
      pushHistory(demo);
      updateTicker(demo);
      setTeams(materialize(demo));
      setLastUpdated(new Date());
    }
  };

  // Optional WebSocket live updates (expects same shape as API response)
  useEffect(() => {
    if (!wsUrl) return;
    let ws;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          const parsed = parsePayload(data);
          if (parsed.length) {
            pushHistory(parsed);
            updateTicker(parsed);
            setTeams(materialize(parsed));
            setLastUpdated(new Date());
          }
        } catch {
          /* ignore */
        }
      };
    } catch {}
    return () => {
      try {
        ws?.close();
      } catch {}
    };
  }, [wsUrl]);

  // Polling
  useEffect(() => {
    fetchScoreboard();
    if (wsUrl) return; // if WS is used, no polling
    const id = setInterval(fetchScoreboard, Math.max(1500, interval));
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, interval, wsUrl]);

  const top = useMemo(() => teams.slice(0, limit), [teams, limit]);

  return (
    <div
      className={classNames(
        "w-screen h-screen overflow-hidden relative",
        overlay ? "bg-transparent" : "bg-slate-950"
      )}
    >
      {/* Enhanced Glow backdrop with particles */}
      {!overlay && (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          {/* Animated gradient orbs */}
          <div className="absolute -top-1/3 -left-1/4 w-[60vw] h-[60vw] rounded-full blur-3xl opacity-40 bg-fuchsia-600 animate-pulse"></div>
          <div
            className="absolute -bottom-1/3 -right-1/4 w-[60vw] h-[60vw] rounded-full blur-3xl opacity-40 bg-cyan-500 animate-pulse"
            style={{ animationDelay: "1s" }}
          ></div>
          <div
            className="absolute top-1/4 right-1/4 w-[40vw] h-[40vw] rounded-full blur-3xl opacity-20 bg-amber-500 animate-pulse"
            style={{ animationDelay: "2s" }}
          ></div>

          {/* Grid pattern overlay */}
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:50px_50px]"></div>

          {/* Radial gradient overlay */}
          <div className="absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_40%,rgba(255,255,255,0.08),rgba(0,0,0,0))]"></div>

          {/* Floating particles */}
          <div className="absolute inset-0">
            {[...Array(20)].map((_, i) => (
              <div
                key={i}
                className="absolute w-1 h-1 bg-cyan-400/30 rounded-full animate-ping"
                style={{
                  left: `${Math.random() * 100}%`,
                  top: `${Math.random() * 100}%`,
                  animationDelay: `${Math.random() * 3}s`,
                  animationDuration: `${2 + Math.random() * 2}s`,
                }}
              />
            ))}
          </div>
        </div>
      )}

      {!overlay && (
        <Header lastUpdated={lastUpdated} loading={loading} error={error} />
      )}

      <main
        className={classNames(
          "mx-auto max-w-6xl px-4",
          overlay ? "pt-2" : "pt-6"
        )}
      >
        <LayoutGroup>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <Leaderboard rows={top} />
            </div>
            <div className="lg:col-span-1 flex flex-col gap-6">
              <Ticker items={ticker} />
              <UndershelfMetrics rows={teams} />
            </div>
          </div>
        </LayoutGroup>
      </main>

      {/* OBS overlay hint */}
      {overlay ? null : (
        <footer className="mt-6 text-center text-xs text-slate-400/70">
          Tip: Add <code>?overlay=1</code> for transparent OBS overlay.
          Configure <code>?limit=8&interval=3000</code>.
        </footer>
      )}
    </div>
  );
}

function Header({ lastUpdated, loading, error }) {
  return (
    <motion.div
      initial={{ y: -50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="sticky top-0 z-10 border-b border-white/10 backdrop-blur-xl bg-slate-950/80"
    >
      <div className="mx-auto max-w-6xl px-4 py-6 flex items-center gap-6">
        <div className={"relative inline-flex items-center group"}>
          <span className="absolute -inset-1 blur-xl opacity-60 bg-gradient-to-r from-fuchsia-500 via-cyan-400 to-amber-400 rounded-full group-hover:opacity-80 transition-opacity duration-300" />
          <div className="relative flex items-center gap-2 rounded-full px-4 py-2 bg-slate-900/80 ring-1 ring-white/20 group-hover:ring-white/30 transition-all duration-300">
            <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs tracking-widest text-slate-200 font-semibold">
              LIVE
            </span>
          </div>
        </div>
        <h1 className="text-3xl font-black tracking-tight text-white flex items-center gap-3 group">
          <motion.div
            animate={{ rotate: [0, 10, -10, 0] }}
            transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
          >
            <Trophy className="h-8 w-8 text-amber-400 drop-shadow-lg" />
          </motion.div>
          <span className="bg-gradient-to-r from-white via-cyan-100 to-white bg-clip-text text-transparent">
            CTF Scoreboard
          </span>
        </h1>
        <div className="ml-auto flex items-center gap-6 text-sm text-slate-300">
          <motion.div
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/50 ring-1 ring-white/10 hover:bg-slate-700/50 transition-all duration-300"
            whileHover={{ scale: 1.05 }}
          >
            <Timer className="h-4 w-4 text-cyan-400" />
            <span className="font-medium">
              {lastUpdated
                ? `Updated ${formatAgo(lastUpdated)}`
                : loading
                ? "Loading…"
                : "–"}
            </span>
          </motion.div>
          <motion.div
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/50 ring-1 ring-white/10 hover:bg-slate-700/50 transition-all duration-300"
            whileHover={{ scale: 1.05 }}
          >
            <Activity className="h-4 w-4 text-fuchsia-400" />
            <span className="font-medium">
              refresh{" "}
              {Math.round(
                (typeof window !== "undefined"
                  ? Number(
                      new URLSearchParams(window.location.search).get(
                        "interval"
                      )
                    ) || 5000
                  : 5000) / 1000
              )}
              s
            </span>
          </motion.div>
        </div>
      </div>
      {error ? (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-auto max-w-6xl px-4 pb-4 -mt-2"
        >
          <div className="text-xs text-red-300/90 bg-red-900/20 px-3 py-2 rounded-lg border border-red-500/30">
            {error}
          </div>
        </motion.div>
      ) : null}
    </motion.div>
  );
}

function Leaderboard({ rows }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, delay: 0.2 }}
      className="rounded-3xl p-1 ring-1 ring-white/20 bg-slate-900/60 backdrop-blur-xl"
    >
      <div className={classNames("rounded-3xl p-6", neonGrad, "bg-opacity-40")}>
        <div className="flex items-center justify-between mb-6">
          <motion.h2
            className="text-xl font-bold text-white/95 flex items-center gap-3"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.4 }}
          >
            <motion.div
              animate={{ rotate: [0, 5, -5, 0] }}
              transition={{ duration: 2, repeat: Infinity, repeatDelay: 4 }}
            >
              <Signal className="h-6 w-6 text-cyan-400" />
            </motion.div>
            Top Teams
          </motion.h2>
          <motion.span
            className="text-sm text-slate-300/90 px-3 py-1 rounded-full bg-slate-800/50 ring-1 ring-white/10"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.6 }}
          >
            E-sport style
          </motion.span>
        </div>
        <ul className="space-y-3">
          <AnimatePresence initial={false}>
            {rows.map((r, index) => (
              <motion.li
                key={r.id}
                layout
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.95 }}
                transition={{
                  type: "spring",
                  stiffness: 400,
                  damping: 30,
                  delay: index * 0.1,
                }}
                whileHover={{
                  scale: 1.02,
                  transition: { duration: 0.2 },
                }}
              >
                <Row r={r} max={rows[0]?.score ?? 1} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>
    </motion.div>
  );
}

function Row({ r, max }) {
  const moveIcon =
    r.move > 0 ? (
      <ArrowUpRight className="h-4 w-4 text-emerald-400" />
    ) : r.move < 0 ? (
      <ArrowDownRight className="h-4 w-4 text-rose-400" />
    ) : (
      <Minus className="h-4 w-4 text-slate-400" />
    );
  const pct = Math.max(0, Math.min(100, (r.score / Math.max(1, max)) * 100));
  const crown =
    r.rank === 1 ? (
      <Crown className="h-6 w-6 text-amber-300 drop-shadow-lg" />
    ) : r.rank <= 3 ? (
      <Flame className="h-5 w-5 text-fuchsia-300 drop-shadow" />
    ) : r.rank <= 5 ? (
      <Star className="h-5 w-5 text-cyan-300" />
    ) : null;

  return (
    <motion.div
      className="relative overflow-hidden rounded-2xl bg-slate-950/70 ring-1 ring-white/20 backdrop-blur-sm group hover:ring-white/30 transition-all duration-300"
      whileHover={{
        scale: 1.01,
        boxShadow: "0 20px 40px rgba(0,0,0,0.3)",
      }}
    >
      {/* Enhanced gradient border */}
      <div className="absolute inset-y-0 left-0 w-2 bg-gradient-to-b from-fuchsia-400 via-cyan-300 to-amber-300 shadow-lg shadow-cyan-500/20" />

      {/* Glow effect for top 3 */}
      {r.rank <= 3 && (
        <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-amber-500/10 via-fuchsia-500/10 to-cyan-500/10 opacity-50" />
      )}

      <div className="p-4">
        <div className="flex items-center gap-4">
          <motion.div
            className={classNames(
              "flex items-center justify-center h-10 w-10 shrink-0 rounded-xl font-bold text-lg transition-all duration-300",
              r.rank === 1
                ? "bg-gradient-to-br from-amber-400 to-yellow-500 text-amber-900 shadow-lg shadow-amber-500/30"
                : r.rank <= 3
                ? "bg-gradient-to-br from-fuchsia-400 to-pink-500 text-fuchsia-900 shadow-lg shadow-fuchsia-500/30"
                : r.rank <= 5
                ? "bg-gradient-to-br from-cyan-400 to-blue-500 text-cyan-900 shadow-lg shadow-cyan-500/30"
                : "bg-slate-800/80 ring-1 ring-white/20 text-slate-200"
            )}
            animate={r.rank === 1 ? { scale: [1, 1.05, 1] } : {}}
            transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
          >
            {r.rank}
          </motion.div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 text-white font-bold text-lg truncate">
              {crown}
              <span className="truncate bg-gradient-to-r from-white to-slate-200 bg-clip-text text-transparent">
                {r.name}
              </span>
            </div>

            {/* Enhanced progress bar */}
            <div className="mt-3 h-3 w-full bg-slate-800/60 rounded-full overflow-hidden ring-1 ring-slate-700/50">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-fuchsia-400 to-amber-300 shadow-lg"
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 1, ease: "easeOut" }}
                style={{
                  boxShadow: `0 0 20px ${
                    pct > 50
                      ? "rgba(6, 182, 212, 0.5)"
                      : "rgba(236, 72, 153, 0.5)"
                  }`,
                }}
              />
            </div>
          </div>

          <div className="ml-auto text-right">
            <motion.div
              className="text-white font-black text-xl tabular-nums bg-gradient-to-r from-white to-slate-200 bg-clip-text text-transparent"
              animate={r.move !== 0 ? { scale: [1, 1.1, 1] } : {}}
              transition={{ duration: 0.5 }}
            >
              {formatScore(r.score)}
            </motion.div>
            <div className="text-sm text-slate-300 flex items-center gap-2 justify-end mt-1">
              <motion.div
                animate={r.move !== 0 ? { x: [0, 5, 0] } : {}}
                transition={{ duration: 0.5 }}
              >
                {moveIcon}
              </motion.div>
              <span className="font-semibold">
                {Math.abs(r.move) ? Math.abs(r.move) : 0}
              </span>
            </div>
          </div>
        </div>

        {/* Enhanced sparkline container */}
        <div className="mt-4 h-12 rounded-lg bg-slate-900/50 ring-1 ring-slate-700/30 p-2">
          <Spark id={r.id} />
        </div>
      </div>
    </motion.div>
  );
}

function Spark({ id }) {
  const [series, setSeries] = useState([]);
  useEffect(() => {
    const iv = setInterval(() => {
      const hist =
        typeof window !== "undefined" && window.__scoreHistory?.get
          ? window.__scoreHistory.get(id) ?? []
          : [];
      setSeries(hist.map((h, i) => ({ x: i, y: h.score })));
    }, 600);
    return () => clearInterval(iv);
  }, [id]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={series}
        margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
      >
        <Line
          type="monotone"
          dataKey="y"
          dot={false}
          strokeWidth={3}
          isAnimationActive={false}
          stroke="url(#gradient)"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <defs>
          <linearGradient id="gradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#06b6d4" />
            <stop offset="50%" stopColor="#ec4899" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
        </defs>
      </LineChart>
    </ResponsiveContainer>
  );
}

function Ticker({ items }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.8, delay: 0.4 }}
      className="rounded-3xl ring-1 ring-white/20 bg-slate-900/60 backdrop-blur-xl p-1"
    >
      <div className={classNames("rounded-3xl p-4", neonGrad, "bg-opacity-40")}>
        <div className="flex items-center gap-3 text-white/95 font-bold mb-4">
          <motion.div
            animate={{ rotate: [0, 10, -10, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, repeatDelay: 2 }}
          >
            <Zap className="h-6 w-6 text-yellow-400 drop-shadow-lg" />
          </motion.div>
          Live Ticker
        </div>
        <div className="h-48 overflow-hidden relative">
          {/* Gradient fade at top and bottom */}
          <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-slate-900/60 to-transparent z-10 pointer-events-none" />
          <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-slate-900/60 to-transparent z-10 pointer-events-none" />

          <AnimatePresence initial={false}>
            {items.slice(0, 10).map((t, index) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 20, x: 20 }}
                animate={{ opacity: 1, y: 0, x: 0 }}
                exit={{ opacity: 0, y: -20, x: -20 }}
                transition={{
                  duration: 0.5,
                  delay: index * 0.1,
                  type: "spring",
                  stiffness: 300,
                  damping: 30,
                }}
                className="text-sm text-slate-100 flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-slate-800/30 transition-all duration-300 group"
              >
                <motion.span
                  className="inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-lg shadow-emerald-400/50"
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{
                    duration: 1,
                    repeat: Infinity,
                    delay: index * 0.2,
                  }}
                />
                <span className="font-semibold flex-1 group-hover:text-white transition-colors duration-300">
                  {t.text}
                </span>
                <span className="text-xs text-slate-400 font-medium">
                  {formatTime(t.when)}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

function UndershelfMetrics({ rows }) {
  const attemptsPerMin = Math.max(1, Math.round(Math.random() * 30 + 10)); // placeholder metric
  const avgScore = rows.length
    ? Math.round(rows.reduce((a, b) => a + b.score, 0) / rows.length)
    : 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, delay: 0.6 }}
      className="grid grid-cols-3 gap-4"
    >
      <MetricCard
        icon={<Activity className="h-5 w-5" />}
        label="Submissions/min"
        value={`${attemptsPerMin}`}
        color="cyan"
      />
      <MetricCard
        icon={<Trophy className="h-5 w-5" />}
        label="Avg Score"
        value={formatScore(avgScore)}
        color="amber"
      />
      <MetricCard
        icon={<Signal className="h-5 w-5" />}
        label="Teams"
        value={`${rows.length}`}
        color="fuchsia"
      />
    </motion.div>
  );
}

function MetricCard({ icon, label, value, color = "cyan" }) {
  const colorClasses = {
    cyan: "text-cyan-400 shadow-cyan-500/20",
    amber: "text-amber-400 shadow-amber-500/20",
    fuchsia: "text-fuchsia-400 shadow-fuchsia-500/20",
  };

  return (
    <motion.div
      className="rounded-2xl p-4 bg-slate-950/70 ring-1 ring-white/20 backdrop-blur-sm hover:ring-white/30 transition-all duration-300 group"
      whileHover={{
        scale: 1.05,
        boxShadow: `0 10px 30px ${
          color === "cyan"
            ? "rgba(6, 182, 212, 0.2)"
            : color === "amber"
            ? "rgba(245, 158, 11, 0.2)"
            : "rgba(236, 72, 153, 0.2)"
        }`,
      }}
    >
      <div className="flex items-center gap-3 mb-2">
        <motion.div
          className={classNames(
            "p-2 rounded-lg bg-slate-800/50",
            colorClasses[color]
          )}
          animate={{ rotate: [0, 5, -5, 0] }}
          transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
        >
          {icon}
        </motion.div>
        <div className="text-sm text-slate-300 font-medium">{label}</div>
      </div>
      <motion.div
        className="text-2xl font-black text-white tabular-nums bg-gradient-to-r from-white to-slate-200 bg-clip-text text-transparent"
        animate={{ scale: [1, 1.05, 1] }}
        transition={{ duration: 2, repeat: Infinity, repeatDelay: 4 }}
      >
        {value}
      </motion.div>
    </motion.div>
  );
}

// Utilities
function formatScore(n) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    n
  );
}
function formatAgo(date) {
  const secs = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs / 60);
  return `${m}m ago`;
}
function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// Demo data generator for fallback / local preview
function buildDemoData() {
  const seed = [
    { id: "alpha", name: "Alpha Wolves", score: 1920 },
    { id: "bravo", name: "Bravo Ninjas", score: 1660 },
    { id: "charlie", name: "Charlie Foxes", score: 1510 },
    { id: "delta", name: "Delta Bytes", score: 1380 },
    { id: "echo", name: "Echo Hunters", score: 1200 },
    { id: "foxtrot", name: "Foxtrot Ops", score: 1180 },
    { id: "golf", name: "Golf Rooters", score: 1100 },
    { id: "hotel", name: "Hotel Pwners", score: 980 },
  ];
  // simulate drift
  return seed.map((t) => ({
    ...t,
    score: t.score + Math.floor(Math.random() * 30),
  }));
}
