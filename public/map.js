// Hex map geometry, shared by the browser and the server so both agree on the board.
export const COLS = 30, ROWS = 19, S3 = Math.sqrt(3);
function rnd(i){ const x = Math.sin(i*12.9898)*43758.5453; return x - Math.floor(x); }

export const HEX = [];   // {id,c,r,x,y}
export const HEXIDX = new Map();
for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
  const x=c+0.5*(r&1), y=r*0.866, cx=(COLS-0.5)/2, cy=(ROWS-1)*0.866/2;
  const dx=(x-cx)/(COLS/2), dy=(y-cy)/((ROWS*0.866)/2), a=Math.atan2(dy,dx);
  const w=1+0.13*Math.sin(a*3+1.3)+0.09*Math.sin(a*5+0.4)+0.07*(rnd(r*COLS+c)-0.5);
  if (dx*dx+dy*dy < w*0.92){ const id=`h${c}_${r}`; HEXIDX.set(id, HEX.length); HEX.push({id,c,r,x:S3*(c+0.5*(r&1)),y:1.5*r}); }
}

export function neighbors(h){
  const odd = h.r & 1;
  const d = odd ? [[1,0],[-1,0],[1,-1],[0,-1],[1,1],[0,1]] : [[1,0],[-1,0],[0,-1],[-1,-1],[0,1],[-1,1]];
  return d.map(([dc,dr])=>`h${h.c+dc}_${h.r+dr}`).filter(id=>HEXIDX.has(id));
}

export const PTS = { call: 1, positive: 5, meeting: 20 };
export const SHIELD_MS = 30000;          // freshly claimed hexes can't be stolen for 30s
export function ptsFor(c,p,m){ return PTS.call + (p?PTS.positive:0) + (m?PTS.meeting:0); }

// Why `slug` can't claim hex `id` right now, or "" if it can. hexAt(id) -> {o,t} | undefined.
// ctx can carry precomputed { mine, free } when checking many hexes at once.
export function claimBlock(id, slug, hexAt, balance, now, ctx){
  const h = hexAt(id);
  if (h?.o===slug) return "yours";
  if (balance < 1) return "log calls to earn points";
  if (h?.o && now - h.t < SHIELD_MS) return "shielded";
  const mine = ctx ? ctx.mine : HEX.some(x=>hexAt(x.id)?.o===slug);
  if (!mine){
    const free = ctx ? ctx.free : HEX.some(x=>!hexAt(x.id)?.o);
    return h?.o && free ? "start on a free hex" : "";
  }
  return neighbors(HEX[HEXIDX.get(id)]).some(n=>hexAt(n)?.o===slug) ? "" : "must touch your territory";
}
