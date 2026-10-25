import { useEffect, useState } from "react";
import { mesh } from "../sos";
import { THEME } from "../theme";

/** The simulated mesh as a node graph: recent hops light up (Demo drawer only). */
export function MeshGraph() {
  const [, redraw] = useState(0);
  useEffect(() => {
    const off = mesh.watch(() => redraw((n) => n + 1));
    const id = window.setInterval(() => redraw((n) => n + 1), 400);   // let lit links fade
    return () => { off(); window.clearInterval(id); };
  }, []);
  const W = 320, H = 170, now = Date.now(), C = THEME.color;
  const pos = (i: number) => [16 + mesh.nodes[i].x * (W - 32), 14 + mesh.nodes[i].y * (H - 28)] as const;
  const recent = mesh.events.filter((e) => now - e.t < 2500 && e.from !== e.to);
  const hot = (a: number, b: number) => recent.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  const busy = (i: number) => mesh.events.some((e) => now - e.t < 2500 && e.to === i && e.from === i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-xl bg-night" role="img" aria-label="simulated mesh of nearby phones">
      {mesh.links.map(([a, b]) => {
        const [x1, y1] = pos(a), [x2, y2] = pos(b), e = hot(a, b);
        const col = !e ? C.edge : e.packet.startsWith("ack") ? C.good : e.kind === "dup" ? C.soft : C.accent;
        return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={col} strokeWidth={e ? 4 : 2} strokeLinecap="round" />;
      })}
      {mesh.nodes.map((n, i) => {
        const [x, y] = pos(i);
        const gw = i === mesh.gateway;
        const fill = i === 0 ? C.accent : gw ? (mesh.gatewaySignal ? C.good : C.bad) : C.raised;
        return (
          <g key={n.id}>
            <circle cx={x} cy={y} r={busy(i) ? 14 : 11} fill={fill} stroke={C.ink} strokeWidth={2} />
            <text x={x} y={y + (n.y > 0.5 ? 26 : -17)} textAnchor="middle" fill={C.soft} fontSize="10">{n.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
