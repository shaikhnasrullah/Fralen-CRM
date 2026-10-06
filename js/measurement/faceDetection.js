import{FaceLandmarker,FilesetResolver}from"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import{headPose}from'./geometry.js';
let lm=null;
export async function loadFace(){
  if(lm)return lm;
  const f=await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  lm=await FaceLandmarker.createFromOptions(f,{baseOptions:{modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"},
    runningMode:"IMAGE",numFaces:1,outputFacialTransformationMatrixes:true});
  return lm;
}
// Returns pixel-space landmarks used downstream, or null. Photo-left eye = patient's RIGHT eye (image not mirrored).
export function detectFace(src){
  if(!lm)return null;
  const r=lm.detect(src);if(!r.faceLandmarks.length)return null;
  const L=r.faceLandmarks[0],W=src.width,H=src.height,P=i=>({x:L[i].x*W,y:L[i].y*H});
  const ring=c=>[c+1,c+2,c+3,c+4].map(P); // iris ring points
  let e=[{p:P(468),ring:ring(468)},{p:P(473),ring:ring(473)}].sort((a,b)=>a.p.x-b.p.x);
  const xs=L.map(p=>p.x*W),ys=L.map(p=>p.y*H),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  return{pupils:{R:e[0].p,L:e[1].p},iris:{R:e[0].ring,L:e[1].ring},
    mid:[10,168,6,4,152].map(P),                       // forehead→chin landmarks for the facial midline
    bbox:{x:x0,y:y0,w:x1-x0,h:y1-y0},inFrame:x0>0&&y0>0&&x1<W&&y1<H,
    pose:r.facialTransformationMatrixes?.[0]?headPose(r.facialTransformationMatrixes[0].data):null};
}
