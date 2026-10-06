import{clamp}from'./geometry.js';
export const LIMITS={yaw:6,pitch:8,roll:4,faceMin:.25,faceMax:.7,minLongSide:1280};
function stats(src,b){ // sharpness (Laplacian variance), brightness, clipped-highlight fraction on the face crop
  const w=240,h=Math.max(8,Math.round(b.h*w/b.w)),c=document.createElement('canvas');c.width=w;c.height=h;
  const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(src,b.x,b.y,b.w,b.h,0,0,w,h);
  const d=x.getImageData(0,0,w,h).data,g=new Float32Array(w*h);let s=0,hi=0;
  for(let i=0;i<g.length;i++){const v=.299*d[i*4]+.587*d[i*4+1]+.114*d[i*4+2];g[i]=v;s+=v;if(v>245)hi++;}
  let m=0,m2=0,n=0;for(let y=1;y<h-1;y++)for(let u=1;u<w-1;u++){const i=y*w+u,l=4*g[i]-g[i-1]-g[i+1]-g[i-w]-g[i+w];m+=l;m2+=l*l;n++;}
  return{lap:m2/n-(m/n)**2,bright:s/g.length,clip:hi/g.length};
}
export function assess(src,f){
  if(!f)return{ok:false,score:0,checks:{face:false},issues:['Face not detected. Face the camera and keep your whole face in view.']};
  const iss=[],ch={},b=f.bbox,fr=b.w/src.width,S=stats(src,{x:Math.max(0,b.x),y:Math.max(0,b.y),w:Math.min(b.w,src.width-b.x),h:Math.min(b.h,src.height-b.y)});
  ch.face=f.inFrame;if(!f.inFrame)iss.push('Keep your face centered, fully inside the frame.');
  ch.distance=fr>=LIMITS.faceMin&&fr<=LIMITS.faceMax;if(fr<LIMITS.faceMin)iss.push('Move closer.');if(fr>LIMITS.faceMax)iss.push('Move back.');
  const p=f.pose,r=p?Math.max(Math.abs(p.yaw)/LIMITS.yaw,Math.abs(p.pitch)/LIMITS.pitch,Math.abs(p.roll)/LIMITS.roll):2;
  ch.pose=r<=1;if(p){if(Math.abs(p.yaw)>LIMITS.yaw)iss.push('Look directly at the camera.');if(Math.abs(p.roll)>LIMITS.roll)iss.push('Keep your head straight.');
    if(Math.abs(p.pitch)>LIMITS.pitch)iss.push(p.pitch>0?'Move the camera slightly higher.':'Move the camera slightly lower.');}else iss.push('Head pose unavailable.');
  ch.light=S.bright>70&&S.bright<200;if(S.bright<=70)iss.push('Low light. Add front lighting.');if(S.bright>=200)iss.push('Overexposed. Reduce light.');
  ch.glare=S.clip<.04;if(!ch.glare)iss.push('Strong reflection. Tilt the glasses slightly or change lighting.');
  ch.sharp=S.lap>40;if(!ch.sharp)iss.push('Image not sharp. Hold still.');
  const sc={sharp:clamp(S.lap/120),light:clamp(1-Math.abs(S.bright-135)/90),pose:r<=1?1:clamp(1-(r-1)/2),glare:clamp(1-S.clip/.1)};
  const score=+((sc.sharp+sc.light+sc.pose+sc.glare)/4).toFixed(2);
  return{ok:Object.values(ch).every(Boolean),score,scores:sc,checks:ch,issues:iss};
}
