// Pure geometry helpers. No DOM, no randomness: every number returned is computed from inputs.
export const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
export const median=a=>{const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};

// Homography from 4 point pairs (direct linear transform, h33 = 1). Returns 9 numbers or null if degenerate.
export function homography(src,dst){
  const A=[],b=[];
  for(let i=0;i<4;i++){const{x,y}=src[i],{x:u,y:v}=dst[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]);b.push(u);
    A.push([0,0,0,x,y,1,-v*x,-v*y]);b.push(v);}
  const h=solve(A,b);return h&&[...h,1];
}
function solve(A,b){ // Gaussian elimination with partial pivoting
  const n=b.length;
  for(let i=0;i<n;i++){let p=i;for(let r=i+1;r<n;r++)if(Math.abs(A[r][i])>Math.abs(A[p][i]))p=r;
    if(Math.abs(A[p][i])<1e-12)return null;
    [A[i],A[p]]=[A[p],A[i]];[b[i],b[p]]=[b[p],b[i]];
    for(let r=i+1;r<n;r++){const f=A[r][i]/A[i][i];for(let c=i;c<n;c++)A[r][c]-=f*A[i][c];b[r]-=f*b[i];}}
  const x=Array(n).fill(0);
  for(let i=n-1;i>=0;i--){let s=b[i];for(let c=i+1;c<n;c++)s-=A[i][c]*x[c];x[i]=s/A[i][i];}
  return x;
}
export function applyH(H,p){const w=H[6]*p.x+H[7]*p.y+1;return{x:(H[0]*p.x+H[1]*p.y+H[2])/w,y:(H[3]*p.x+H[4]*p.y+H[5])/w};}

// Head pose (degrees) from MediaPipe's column-major 4x4 facial transformation matrix.
// Sign conventions must be confirmed on-device; thresholds only use absolute values.
export function headPose(d){
  const R=(i,j)=>d[j*4+i],deg=180/Math.PI,fold=a=>Math.abs(a)>90?(a>0?180-a:-180-a):a;
  return{yaw:Math.asin(clamp(-R(2,0),-1,1))*deg,pitch:fold(Math.atan2(R(2,1),R(2,2))*deg),roll:fold(Math.atan2(R(1,0),R(0,0))*deg)};
}

// Total-least-squares line through points (facial midline). dir runs from first to last point.
export function fitLine(P){
  const n=P.length,cx=P.reduce((s,p)=>s+p.x,0)/n,cy=P.reduce((s,p)=>s+p.y,0)/n;
  let sxx=0,syy=0,sxy=0;P.forEach(p=>{const dx=p.x-cx,dy=p.y-cy;sxx+=dx*dx;syy+=dy*dy;sxy+=dx*dy;});
  const t=.5*Math.atan2(2*sxy,sxx-syy);let d={x:Math.cos(t),y:Math.sin(t)};
  if(d.x*(P[n-1].x-P[0].x)+d.y*(P[n-1].y-P[0].y)<0)d={x:-d.x,y:-d.y};
  const nrm={x:-d.y,y:d.x};
  const rms=Math.sqrt(P.reduce((s,p)=>s+((p.x-cx)*nrm.x+(p.y-cy)*nrm.y)**2,0)/n);
  return{c:{x:cx,y:cy},dir:d,nrm,rms};
}
export const sideOf=(p,L)=>(p.x-L.c.x)*L.nrm.x+(p.y-L.c.y)*L.nrm.y;   // signed distance from line
export const alongDir=(a,b,L)=>(b.x-a.x)*L.dir.x+(b.y-a.y)*L.dir.y;  // distance along line direction
