import{homography,dist,clamp}from'./geometry.js';
export const CARD={w:85.6,h:53.98}; // ISO/IEC 7810 ID-1 (bank/ATM card)
/* Perspective-aware calibration: 4 card corners -> homography onto the card's metric plane (mm).
   Every image point is then converted with applyH(), so scale is NOT one global mm/px value.
   LIMITS: (1) the card plane must be close to the pupil/frame plane (hold it beside the eye, flat);
   depth offset between planes is not corrected. (2) Lens distortion is NOT corrected (browsers expose no intrinsics).
   (3) Corners are user-marked; fiducial (ArUco/AprilTag) auto-detection plugs in via window.FRALEN_MARKER_DETECTOR. */
export function calibrateCard(pts,res){
  if(pts.length!==4)return{ok:false,reason:'Mark all 4 card corners.'};
  const c={x:pts.reduce((s,p)=>s+p.x,0)/4,y:pts.reduce((s,p)=>s+p.y,0)/4};
  let q=[...pts].sort((a,b)=>Math.atan2(a.y-c.y,a.x-c.x)-Math.atan2(b.y-c.y,b.x-c.x));
  const k=q.reduce((m,p,i)=>p.x+p.y<q[m].x+q[m].y?i:m,0);q=[...q.slice(k),...q.slice(0,k)]; // start at top-left
  const side=()=>[dist(q[0],q[1]),dist(q[1],q[2]),dist(q[3],q[2]),dist(q[0],q[3])]; // top,right,bottom,left
  let[t,r,b,l]=side();
  if((t+b)<(l+r)){q=[...q.slice(1),q[0]];[t,r,b,l]=side();} // card held portrait: long side first
  const cr=(a,b,c)=>(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x),s=[0,1,2,3].map(i=>cr(q[i],q[(i+1)%4],q[(i+2)%4]));
  if(!(s.every(v=>v>0)||s.every(v=>v<0)))return{ok:false,reason:'Corners are not a valid rectangle. Re-mark them in order.'};
  const W=(t+b)/2,Hh=(l+r)/2,persp=Math.max(Math.max(t,b)/Math.min(t,b),Math.max(l,r)/Math.min(l,r));
  if(persp>1.3)return{ok:false,reason:'Card is too tilted. Hold it flat and facing the camera.'};
  if(W<res.w*.08)return{ok:false,reason:'Card is too small in the image. Move closer.'};
  const H=homography(q,[{x:0,y:0},{x:CARD.w,y:0},{x:CARD.w,y:CARD.h},{x:0,y:CARD.h}]);
  if(!H)return{ok:false,reason:'Calibration failed (degenerate corners).'};
  const confidence=+(clamp(1-(persp-1)/.3)*clamp(W/(res.w*.15))*.9).toFixed(2); // .9 cap: corners are manually marked
  return{ok:true,H,corners:q,confidence,method:'CARD_4_CORNER_HOMOGRAPHY',cardWidthPx:+W.toFixed(1),cardHeightPx:+Hh.toFixed(1),
    physicalWidthMm:CARD.w,physicalHeightMm:CARD.h,cameraResolution:`${res.w}x${res.h}`,distortionStatus:'NOT_CORRECTED_NO_INTRINSICS'};
}
